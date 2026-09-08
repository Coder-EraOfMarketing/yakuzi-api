import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  Logger,
  Inject,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import axios from 'axios';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service';
import { parseAdminGrants } from '../../common/admin-access';
import { REDIS_CLIENT } from '../../config/redis.config';
import { Role, UserStatus } from '@prisma/client';
import { OtpSmsService } from './services/otp-sms.service';
import { MailService } from '../mail/mail.service';
import { RegisterBuyerDto } from './dto/register-buyer.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

// ─── Constants ───────────────────────────────────────

const OTP_TTL_SECONDS = 120; // 2 minutes
const OTP_RATE_LIMIT_WINDOW = 60; // 1 minute
const OTP_RATE_LIMIT_MAX = 3; // max 3 OTPs per minute per phone

// ─── Interfaces ──────────────────────────────────────

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * The subset of Google's tokeninfo response this service relies on. Every value
 * arrives as a string, including the booleans and the timestamps.
 */
interface GoogleTokenInfo {
  aud?: string;
  iss?: string;
  exp?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
}

export interface AuthResponse extends TokenPair {
  user: {
    id: string;
    phone: string | null;
    email: string | null;
    role: Role;
    status: UserStatus;
  };
  isNewUser: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly otpSmsService: OtpSmsService,
    private readonly mailService: MailService,
  ) {}

  // ─── SEND OTP ──────────────────────────────────────

  async sendOtp(contact: string): Promise<{ message: string }> {
    // Rate limiting: max 3 OTP requests per minute per contact
    await this.enforceRateLimit(contact);

    // Generate 6-digit OTP
    const otp = this.generateOtp();

    // Store OTP in Redis with TTL
    const redisKey = `otp:${contact}`;
    await this.redis.setex(redisKey, OTP_TTL_SECONDS, otp);

    // Increment rate limit counter
    const rateLimitKey = `otp_rate:${contact}`;
    const currentCount = await this.redis.incr(rateLimitKey);
    if (currentCount === 1) {
      await this.redis.expire(rateLimitKey, OTP_RATE_LIMIT_WINDOW);
    }

    const isEmail = contact.includes('@');

    if (isEmail) {
      // Mirrors the SMS branch below: refuse loudly when we cannot deliver,
      // and drop the stored OTP rather than leave a live code nobody received.
      if (!this.mailService.isConfigured()) {
        await this.discardOtp(redisKey);
        this.logger.error(
          `Email OTP requested for ${this.maskContact(contact)} but SMTP is not configured (SMTP_USER / SMTP_APP_PASSWORD unset).`,
        );
        throw new ServiceUnavailableException(
          'Email verification is not available yet. Please sign up with your mobile number.',
        );
      }

      const result = await this.mailService.sendMail({
        to: contact,
        subject: `${otp} is your Yukizi verification code`,
        text: `Your Yukizi verification code is ${otp}. It expires in ${Math.round(OTP_TTL_SECONDS / 60)} minutes. If you did not request it, you can ignore this email.`,
        html: `<p>Your Yukizi verification code is:</p>
<p style="font-size:24px;font-weight:bold;letter-spacing:3px;margin:16px 0">${otp}</p>
<p>It expires in ${Math.round(OTP_TTL_SECONDS / 60)} minutes. If you did not request it, you can ignore this email.</p>`,
      });

      if (!result.sent) {
        await this.discardOtp(redisKey);
        this.logger.error(
          `Email OTP delivery failed for ${this.maskContact(contact)} (retryable: ${result.retryable}).`,
        );
        throw new ServiceUnavailableException(
          'We could not send the verification email. Please try again, or sign up with your mobile number.',
        );
      }

      this.logger.log(`OTP sent to ${this.maskContact(contact)} via email`);
      return { message: 'OTP sent successfully' };
    }

    // Send OTP via Nimbus IT SMS service
    if (!this.otpSmsService.isConfigured()) {
      await this.discardOtp(redisKey);
      this.logger.error(
        'SMS gateway credentials are not configured; cannot send OTP.',
      );
      throw new ServiceUnavailableException(
        'We cannot send OTPs right now. Please try again later.',
      );
    }

    const result = await this.otpSmsService.sendOtp(contact, otp);

    if (!result.success) {
      // The OTP never reached the user, so leaving it live in Redis only
      // widens the window for guessing it.
      await this.discardOtp(redisKey);
      this.logger.error(
        `OTP delivery failed for ${this.maskContact(contact)}: ${result.reason ?? 'unknown reason'}`,
      );
      throw new ServiceUnavailableException(
        'We could not send the OTP. Please check the number and try again.',
      );
    }

    this.logger.log(`OTP sent to ${this.maskContact(contact)} via SMS`);
    return { message: 'OTP sent successfully' };
  }

  /** Drop an OTP that was never delivered. Never throws. */
  private async discardOtp(redisKey: string): Promise<void> {
    try {
      if (this.redis) await this.redis.del(redisKey);
    } catch {
      // best effort — the TTL will clear it
    }
  }

  /** Keep phone numbers and addresses out of the logs. */
  private maskContact(contact: string): string {
    if (contact.includes('@')) {
      const [name, domain] = contact.split('@');
      return `${name.slice(0, 2)}***@${domain}`;
    }
    return contact.length <= 4
      ? '****'
      : `${'*'.repeat(contact.length - 4)}${contact.slice(-4)}`;
  }

  // ─── VERIFY OTP ────────────────────────────────────

  async verifyOtp(
    phone: string,
    otp: string,
    suggestedRole?: Role,
  ): Promise<AuthResponse> {
    const redisKey = `otp:${phone}`;
    const cleanPhone = phone.replace(/\D/g, '');

    let storedOtp: string | null = null;
    try {
      if (this.redis) {
        storedOtp = await this.redis.get(redisKey);
      }
    } catch (redisErr) {
      // Fail closed. This used to fall through to the well-known-code
      // fallback below, which meant an unreachable OTP store downgraded
      // every account to "type 123456 to log in".
      this.logger.error(
        `Redis fetch failed during OTP verification: ${redisErr instanceof Error ? redisErr.message : 'Unknown error'}`,
      );
      throw new ServiceUnavailableException(
        'Unable to verify the OTP right now. Please try again in a moment.',
      );
    }

    if (!storedOtp) {
      throw new BadRequestException(
        'OTP expired or not found. Please request a new OTP.',
      );
    }

    const normalizedOtp = otp.trim();
    const normalizedStoredOtp = storedOtp.trim();

    // Constant-time, matching registerBuyer's comparison.
    if (
      normalizedOtp.length !== normalizedStoredOtp.length ||
      !crypto.timingSafeEqual(
        Buffer.from(normalizedOtp),
        Buffer.from(normalizedStoredOtp),
      )
    ) {
      throw new BadRequestException('Invalid OTP');
    }

    try {
      if (this.redis) {
        await this.redis.del(redisKey);
      }
    } catch (err) {
      // Ignore redis deletion error
    }

    // Find or create user
    let isNewUser = false;
    let user = await this.prisma.user.findUnique({
      where: { phone },
      select: {
        id: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        adminProfile: {
          select: {
            id: true,
            displayName: true,
            department: true,
            permissions: true,
          },
        },
      },
    });

    // ADMIN ACCESS: Super admin 9831864222 is auto-approved, other admin requests set role to ADMIN with PENDING status
    const isAdminBypassPhone = cleanPhone === '9831864222';
    if (isAdminBypassPhone) {
      suggestedRole = Role.ADMIN;
    }

    // Force test seller numbers
    if (cleanPhone === '8888888888' || cleanPhone === '8888888889') {
      suggestedRole = Role.SELLER;
    }

    if (user && isAdminBypassPhone && (user.role !== Role.ADMIN || user.status !== UserStatus.APPROVED)) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { role: Role.ADMIN, status: UserStatus.APPROVED },
        select: {
          id: true,
          phone: true,
          email: true,
          role: true,
          status: true,
          adminProfile: {
            select: {
              id: true,
              displayName: true,
              department: true,
              permissions: true,
            },
          },
        },
      });
      this.logger.log(`Super Admin ${user.phone} role and status verified upon login`);
    } else if (
      user &&
      suggestedRole &&
      user.role !== suggestedRole
    ) {

      // User exists but has a different role (e.g. BUYER logging into ADMIN or SELLER app)
      // Update the user's role and set status to PENDING if switching to ADMIN
      const newStatus = suggestedRole === Role.ADMIN ? UserStatus.PENDING : user.status;
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { role: suggestedRole, status: newStatus },
        select: {
          id: true,
          phone: true,
          email: true,
          role: true,
          status: true,
          adminProfile: {
            select: {
              id: true,
              displayName: true,
              department: true,
              permissions: true,
            },
          },
        },
      });
      this.logger.log(
        `User ${user.id} role updated from previous role to ${suggestedRole} upon login`,
      );
    }


    if (!user) {
      isNewUser = true;

      // Generate a random placeholder password (user authenticates via OTP, not password)
      const randomPassword = Math.random().toString(36).substring(2) + Date.now().toString(36);

      user = await this.prisma.user.create({
        data: {
          phone,
          password: randomPassword,
          role: suggestedRole || Role.BUYER,
          status: UserStatus.PENDING,
        },
        select: {
          id: true,
          phone: true,
          email: true,
          role: true,
          status: true,
          adminProfile: {
            select: {
              id: true,
              displayName: true,
              department: true,
              permissions: true,
            },
          },
        },
      });

      this.logger.log(`New user registered: ${phone} (${user.id})`);
    }

    // Lazy ensure profiles exist even for existing users (migrated/promoted)
    try {
      if (user.role === Role.ADMIN) {
        const profile = await this.prisma.adminProfile.findUnique({
          where: { userId: user.id },
        });
        if (!profile) {
          await this.prisma.adminProfile.create({
            data: {
              userId: user.id,
              displayName: 'Universal Admin',
              department: 'Management',
              permissions: '*',
            },
          });
          this.logger.log(
            `Lazily created AdminProfile for existing user ${user.id}`,
          );
        }
      } else if (user.role === Role.SELLER) {
        const profile = await this.prisma.sellerProfile.findUnique({
          where: { userId: user.id },
        });
        if (!profile) {
          await this.prisma.sellerProfile.create({
            data: {
              userId: user.id,
              companyName: '',
              gstNumber: '',
              panNumber: '',
              drugLicenseNumber: '',
              drugLicenseUrl: '',
              address: '',
              city: '',
              state: '',
              pincode: '',
              verificationStatus: 'UNVERIFIED',
              rating: 0,
            },
          });
          this.logger.log(
            `Lazily created SellerProfile for existing user ${user.id}`,
          );
        }
      } else if (user.role === Role.BUYER) {
        const profile = await this.prisma.buyerProfile.findUnique({
          where: { userId: user.id },
        });
        if (!profile) {
          await this.prisma.buyerProfile.create({
            data: {
              userId: user.id,
              legalName: '',
              gstNumber: '',
              panNumber: '',
              drugLicenseNumber: '',
              drugLicenseUrl: '',
              address: '',
              city: '',
              state: '',
              pincode: '',
            },
          });
          this.logger.log(
            `Lazily created BuyerProfile for existing user ${user.id}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`Lazy profile creation notice: ${err instanceof Error ? err.message : 'Unknown warning'}`);
    }


    // Generate JWT tokens
    const tokens = await this.generateTokens(user.id, user.role);

    return {
      ...tokens,
      user,
      isNewUser,
    };
  }

  // ─── REGISTER BUYER ────────────────────────────────
  async registerBuyer(dto: RegisterBuyerDto): Promise<AuthResponse> {
    const { contact, otp, realName, password, dob, gender, username } = dto;
    const isEmail = contact.includes('@');
    const redisKey = `otp:${contact}`;

    // Verify OTP using Redis
    const storedOtp = await this.redis.get(redisKey);
    if (!storedOtp) {
      throw new BadRequestException(
        'OTP expired or not found. Please request a new OTP.',
      );
    }
    const normalizedOtp = otp.trim();
    const normalizedStoredOtp = storedOtp.trim();

    if (
      normalizedOtp.length !== normalizedStoredOtp.length ||
      !crypto.timingSafeEqual(
        Buffer.from(normalizedOtp),
        Buffer.from(normalizedStoredOtp),
      )
    ) {
      throw new BadRequestException('Invalid OTP');
    }

    // Delete OTP from Redis
    await this.redis.del(redisKey);

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const dobDate = dob ? new Date(dob) : null;

    let user;
    let isNewUser = false;

    // Use transaction to ensure both user and profile are created
    await this.prisma.$transaction(async (prisma) => {
      // Check if user exists
      user = await prisma.user.findFirst({
        where: isEmail ? { email: contact } : { phone: contact },
      });

      if (!user) {
        isNewUser = true;
        // Check if username is taken
        if (username) {
          const existingUsername = await prisma.user.findUnique({
            where: { username },
          });
          if (existingUsername) {
            throw new BadRequestException('Username is already taken');
          }
        }

        user = await prisma.user.create({
          data: {
            phone: isEmail ? null : contact,
            email: isEmail ? contact : null,
            username: username || null,
            password: hashedPassword,
            gender: gender || null,
            dob: dobDate,
            role: Role.BUYER,
            status: UserStatus.APPROVED,
          },
        });

        await prisma.buyerProfile.create({
          data: {
            userId: user.id,
            legalName: realName,
            address: '',
            city: '',
            state: '',
            pincode: '',
          },
        });
      } else {
        // Update existing user
        if (username && username !== user.username) {
          const existingUsername = await prisma.user.findUnique({
            where: { username },
          });
          if (existingUsername) {
            throw new BadRequestException('Username is already taken');
          }
        }

        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            username: username || user.username,
            password: hashedPassword,
            gender: gender || user.gender,
            dob: dobDate || user.dob,
            status: UserStatus.APPROVED,
          },
        });

        // Update profile
        const profile = await prisma.buyerProfile.findUnique({
          where: { userId: user.id },
        });
        if (profile) {
          await prisma.buyerProfile.update({
            where: { userId: user.id },
            data: { legalName: realName },
          });
        } else {
          await prisma.buyerProfile.create({
            data: {
              userId: user.id,
              legalName: realName,
              address: '',
              city: '',
              state: '',
              pincode: '',
            },
          });
        }
      }
    });

    const tokens = await this.generateTokens(user.id, user.role);

    return {
      ...tokens,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        role: user.role,
        status: user.status,
      },
      isNewUser,
    };
  }

  // ─── RESET PASSWORD ────────────────────────────────
  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const { contact, otp, newPassword } = dto;
    const isEmail = contact.includes('@');
    const redisKey = `otp:${contact}`;

    // Verify OTP using Redis
    const storedOtp = await this.redis.get(redisKey);
    if (!storedOtp) {
      throw new BadRequestException(
        'OTP expired or not found. Please request a new OTP.',
      );
    }
    const normalizedOtp = otp.trim();
    const normalizedStoredOtp = storedOtp.trim();

    if (
      normalizedOtp.length !== normalizedStoredOtp.length ||
      !crypto.timingSafeEqual(
        Buffer.from(normalizedOtp),
        Buffer.from(normalizedStoredOtp),
      )
    ) {
      throw new BadRequestException('Invalid OTP');
    }

    // Delete OTP from Redis
    await this.redis.del(redisKey);

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update the user's password
    const user = await this.prisma.user.updateMany({
      where: isEmail
        ? { email: contact }
        : { OR: [{ phone: contact }, { username: contact }] },
      data: { password: hashedPassword },
    });

    if (user.count === 0) {
      throw new NotFoundException('User not found');
    }

    return { message: 'Password updated successfully' };
  }

  // ─── LOGIN WITH SIMPLE PASSWORD ───────────────────

  async loginWithSimplePassword(password: string): Promise<AuthResponse> {
    const configPassword = this.configService.get<string>(
      'ADMIN_BLOG_PASSWORD',
    );

    if (!configPassword || password.trim() !== configPassword.trim()) {
      throw new UnauthorizedException('Invalid admin password');
    }

    // Find the first admin user to represent the blog admin
    const adminUser = await this.prisma.user.findFirst({
      where: { role: Role.ADMIN },
      select: {
        id: true,
        phone: true,
        email: true,
        role: true,
        status: true,
      },
    });

    if (!adminUser) {
      throw new NotFoundException('No admin user found in system');
    }

    const tokens = await this.generateTokens(adminUser.id, adminUser.role);

    return {
      ...tokens,
      user: adminUser,
      isNewUser: false,
    };
  }

  // ─── LOGIN WITH PASSWORD ───────────────────────────

  async loginWithPassword(
    contact: string,
    password: string,
  ): Promise<AuthResponse> {
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);

    const user = await this.prisma.user.findFirst({
      where: isEmail
        ? { email: contact }
        : { OR: [{ phone: contact }, { username: contact }] },
      select: {
        id: true,
        phone: true,
        email: true,
        password: true,
        role: true,
        status: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.role !== Role.BUYER) {
      throw new UnauthorizedException('Access denied. Buyers only.');
    }

    if (!user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(user.id, user.role);

    return {
      ...tokens,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        role: user.role,
        status: user.status,
      },
      isNewUser: false,
    };
  }

  // ─── GOOGLE SIGN-IN ────────────────────────────────

  /**
   * Signs a buyer in with the ID token that Google Identity Services issues in
   * the browser.
   *
   * The token is checked through Google's tokeninfo endpoint rather than by
   * adding google-auth-library. The deploy runs `npm ci` on the server, so a new
   * dependency is a deploy-time risk for the whole API, and tokeninfo performs
   * the same signature validation on Google's side.
   *
   * Verification is inert until GOOGLE_CLIENT_ID is set: with no client id there
   * is nothing to check the token's audience against, so the endpoint refuses
   * rather than trusting it.
   */
  async loginWithGoogle(idToken: string): Promise<AuthResponse> {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) {
      this.logger.warn(
        'Google sign-in was attempted but GOOGLE_CLIENT_ID is not configured',
      );
      throw new ServiceUnavailableException(
        'Google sign-in is not available right now.',
      );
    }

    let claims: GoogleTokenInfo;
    try {
      const response = await axios.get<GoogleTokenInfo>(
        'https://oauth2.googleapis.com/tokeninfo',
        { params: { id_token: idToken }, timeout: 8000 },
      );
      claims = response.data;
    } catch {
      // Covers both a rejected token and Google being unreachable. The client
      // gets one message either way; the distinction is not the user's problem.
      this.logger.warn('Google did not accept the supplied ID token');
      throw new UnauthorizedException('Google sign-in failed. Please try again.');
    }

    // Google validated the signature. These claims still have to be checked
    // here: a perfectly valid token issued to a DIFFERENT application would
    // otherwise be accepted as a login to this one.
    if (claims.aud !== clientId) {
      this.logger.warn('Google ID token was issued for a different client id');
      throw new UnauthorizedException('Google sign-in failed. Please try again.');
    }

    const issuer = (claims.iss || '').replace(/^https:\/\//, '');
    if (issuer !== 'accounts.google.com') {
      throw new UnauthorizedException('Google sign-in failed. Please try again.');
    }

    const expiresAt = Number(claims.exp);
    if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now()) {
      throw new UnauthorizedException('Google sign-in expired. Please try again.');
    }

    // tokeninfo returns the booleans as strings.
    if (String(claims.email_verified) !== 'true') {
      throw new UnauthorizedException(
        'This Google account does not have a verified email address.',
      );
    }

    const email = (claims.email || '').trim().toLowerCase();
    if (!email) {
      throw new UnauthorizedException(
        'This Google account did not share an email address.',
      );
    }

    let user = await this.prisma.user.findUnique({ where: { email } });
    let isNewUser = false;

    if (user) {
      // An account already registered with this email signs in, rather than a
      // duplicate being created. Sellers and admins are deliberately excluded:
      // this is the buyer storefront, and their accounts carry other privileges.
      if (user.role !== Role.BUYER) {
        throw new UnauthorizedException(
          'This email is registered to a staff account. Please sign in with your password.',
        );
      }
      if (user.status === UserStatus.BLOCKED) {
        throw new UnauthorizedException('This account has been blocked.');
      }
    } else {
      isNewUser = true;
      const displayName = (claims.name || '').trim();

      user = await this.prisma.user.create({
        data: {
          email,
          role: Role.BUYER,
          // Matches registerBuyer: a buyer who signs up is approved, not left
          // pending, or they cannot use the storefront they just joined.
          status: UserStatus.APPROVED,
        },
      });

      await this.prisma.buyerProfile.create({
        data: { userId: user.id, legalName: displayName },
      });

      this.logger.log(`Created buyer ${user.id} from a Google sign-in`);
    }

    // Existing accounts created before this path may have no profile yet.
    const profile = await this.prisma.buyerProfile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) {
      await this.prisma.buyerProfile.create({
        data: { userId: user.id, legalName: (claims.name || '').trim() },
      });
    }

    const tokens = await this.generateTokens(user.id, user.role);

    return {
      ...tokens,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        role: user.role,
        status: user.status,
      },
      isNewUser,
    };
  }

  // ─── GET CURRENT USER (ME) ─────────────────────────

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        buyerProfile: {
          select: {
            id: true,
            legalName: true,
            city: true,
            state: true,
          },
        },
        sellerProfile: {
          select: {
            id: true,
            companyName: true,
            verificationStatus: true,
            city: true,
            state: true,
          },
        },
        adminProfile: {
          select: {
            id: true,
            displayName: true,
            department: true,
            permissions: true,
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // The admin panel decides which tabs and buttons to render from this.
    // Parsed here so the client never has to know the storage format, and so
    // a legacy permissions string reads as Super Admin on the client exactly
    // as it does in AdminAccessGuard.
    if (user.adminProfile) {
      const grants = parseAdminGrants(user.adminProfile.permissions);
      return {
        ...user,
        adminProfile: {
          ...user.adminProfile,
          access: { isSuper: grants.isSuper, tabs: grants.tabs },
        },
      };
    }

    return user;
  }

  // ─── REFRESH TOKEN ─────────────────────────────────

  async refreshToken(refreshToken: string): Promise<TokenPair> {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Verify user still exists and is not blocked
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true, status: true },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      if (user.status === 'BLOCKED') {
        throw new UnauthorizedException('Account is blocked');
      }

      return this.generateTokens(user.id, user.role);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  // ─── PRIVATE HELPERS ───────────────────────────────

  private generateOtp(): string {
    // Cryptographically secure 6-digit OTP
    const buffer = crypto.randomBytes(4);
    const num = buffer.readUInt32BE(0) % 900000;
    return String(num + 100000);
  }

  private async generateTokens(userId: string, role: Role): Promise<TokenPair> {
    const payload = { sub: userId, role };
    const secret = this.configService.get<string>('JWT_SECRET') || 'yukizi_fallback_secret_key_2026';

    // The admin panel has no token-refresh loop — when the access token
    // expires, the 401 interceptor logs the admin out mid-work. Admins get a
    // longer working session; buyer/seller token lifetimes are unchanged.
    const accessExpiresIn =
      role === Role.ADMIN
        ? this.configService.get<string>('JWT_ADMIN_ACCESS_EXPIRES', '8h')
        : this.configService.get<string>('JWT_ACCESS_EXPIRES', '15m');
    const refreshExpiresIn = this.configService.get<string>(
      'JWT_REFRESH_EXPIRES',
      '7d',
    );

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret,
        expiresIn: accessExpiresIn as any,
      }),
      this.jwtService.signAsync(payload, {
        secret,
        expiresIn: refreshExpiresIn as any,
      }),
    ]);

    return { accessToken, refreshToken };
  }


  private async enforceRateLimit(phone: string): Promise<void> {
    const rateLimitKey = `otp_rate:${phone}`;
    const count = await this.redis.get(rateLimitKey);

    if (count && parseInt(count, 10) >= OTP_RATE_LIMIT_MAX) {
      throw new HttpException(
        'Too many OTP requests. Please try again after 1 minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
