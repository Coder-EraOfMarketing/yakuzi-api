import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RegisterBuyerDto } from './dto/register-buyer.dto';
import { LoginPasswordDto } from './dto/login-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { AppleLoginDto } from './dto/apple-login.dto';
import { FacebookLoginDto } from './dto/facebook-login.dto';
import { WebAnalyticsService } from '../web-analytics/web-analytics.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly webAnalytics: WebAnalyticsService,
  ) {}

  private sanitizeContact(phone?: string, contact?: string): string {

    let raw = (phone || contact || '').trim();

    if (!raw) {
      throw new BadRequestException('Phone number or contact is required');
    }

    if (raw.includes('or')) {
      const parts = raw.split('or').map((p) => p.trim());
      const phoneMatch = parts.find((p) => /^[6-9]\d{9}$/.test(p));
      const emailMatch = parts.find((p) => p.includes('@'));
      raw = phoneMatch || emailMatch || parts[parts.length - 1];
    }

    if (!raw.includes('@')) {
      const digitsOnly = raw.replace(/\D/g, '');
      if (digitsOnly.length >= 10) {
        raw = digitsOnly.slice(-10);
      }
    }

    return raw;
  }

  @Post('send-otp')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send OTP to contact (phone or email)' })
  @ApiResponse({ status: 200, description: 'OTP sent successfully' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async sendOtp(@Body() dto: SendOtpDto) {
    const contactMethod = this.sanitizeContact(dto.phone, dto.contact);
    return this.authService.sendOtp(contactMethod);
  }

  @Post('verify-otp')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify OTP and receive JWT tokens' })
  @ApiResponse({ status: 200, description: 'OTP verified, tokens returned' })
  @ApiResponse({ status: 401, description: 'Invalid or expired OTP' })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Headers('x-visitor-id') visitorId?: string,
  ) {
    const phoneNumber = this.sanitizeContact(dto.phone, dto.contact);
    const result = await this.authService.verifyOtp(phoneNumber, dto.otp, dto.role);
    // Analytics only — detached, never blocks or fails the login.
    void this.webAnalytics.identify({
      visitorId,
      userId: result.user.id,
      method: phoneNumber.includes('@') ? 'email-otp' : 'phone-otp',
      isSignup: result.isNewUser,
    });
    return result;
  }


  @Post('buyer/register')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register a new buyer with full profile' })
  @ApiResponse({
    status: 200,
    description: 'Registration successful, tokens returned',
  })
  async registerBuyer(
    @Body() dto: RegisterBuyerDto,
    @Headers('x-visitor-id') visitorId?: string,
  ) {
    const result = await this.authService.registerBuyer(dto);
    void this.webAnalytics.identify({
      visitorId,
      userId: result.user.id,
      method: 'register-form',
      isSignup: result.isNewUser,
    });
    return result;
  }

  @Post('reset-password')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset user password using OTP' })
  @ApiResponse({ status: 200, description: 'Password reset successful' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('login-simple')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with ONLY password (Blog Admin OTP-less)' })
  @ApiResponse({
    status: 200,
    description: 'Login successful, tokens returned',
  })
  @ApiResponse({ status: 401, description: 'Invalid password' })
  async loginWithSimplePassword(@Body('password') password: string) {
    return this.authService.loginWithSimplePassword(password);
  }

  @Post('login-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Login with contact (email/phone/username) and password (Buyers only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Login successful, tokens returned',
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async loginWithPassword(
    @Body() dto: LoginPasswordDto,
    @Headers('x-visitor-id') visitorId?: string,
  ) {
    const result = await this.authService.loginWithPassword(dto.contact, dto.password);
    void this.webAnalytics.identify({
      visitorId,
      userId: result.user.id,
      method: 'password',
      isSignup: result.isNewUser,
    });
    return result;
  }

  @Post('google')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Sign in with a Google ID token (Buyers only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Login successful, tokens returned',
  })
  @ApiResponse({ status: 401, description: 'Google rejected the token' })
  @ApiResponse({
    status: 503,
    description: 'GOOGLE_CLIENT_ID is not configured on the server',
  })
  async loginWithGoogle(
    @Body() dto: GoogleLoginDto,
    @Headers('x-visitor-id') visitorId?: string,
  ) {
    const result = await this.authService.loginWithGoogle(dto.idToken);
    void this.webAnalytics.identify({
      visitorId,
      userId: result.user.id,
      method: 'google',
      isSignup: result.isNewUser,
    });
    return result;
  }

  @Post('apple')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Sign in with an Apple identity token (Buyers only)' })
  @ApiResponse({ status: 200, description: 'Login successful, tokens returned' })
  @ApiResponse({ status: 401, description: 'Apple rejected the token' })
  @ApiResponse({
    status: 503,
    description: 'APPLE_CLIENT_ID is not configured on the server',
  })
  async loginWithApple(
    @Body() dto: AppleLoginDto,
    @Headers('x-visitor-id') visitorId?: string,
  ) {
    const result = await this.authService.loginWithApple(dto.idToken);
    void this.webAnalytics.identify({
      visitorId,
      userId: result.user.id,
      method: 'apple',
      isSignup: result.isNewUser,
    });
    return result;
  }

  @Post('facebook')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Sign in with a Facebook access token (Buyers only)' })
  @ApiResponse({ status: 200, description: 'Login successful, tokens returned' })
  @ApiResponse({ status: 401, description: 'Facebook rejected the token' })
  @ApiResponse({
    status: 503,
    description: 'FACEBOOK_APP_ID / FACEBOOK_APP_SECRET are not configured on the server',
  })
  async loginWithFacebook(
    @Body() dto: FacebookLoginDto,
    @Headers('x-visitor-id') visitorId?: string,
  ) {
    const result = await this.authService.loginWithFacebook(dto.accessToken);
    void this.webAnalytics.identify({
      visitorId,
      userId: result.user.id,
      method: 'facebook',
      isSignup: result.isNewUser,
    });
    return result;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh JWT access token' })
  @ApiResponse({ status: 200, description: 'New token pair returned' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refreshToken(@Body('refreshToken') refreshToken: string) {
    return this.authService.refreshToken(refreshToken);
  }

  @Get('me')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current authenticated user profile' })
  @ApiResponse({ status: 200, description: 'User profile returned' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMe(@CurrentUser('id') userId: string) {
    return this.authService.getMe(userId);
  }
}
