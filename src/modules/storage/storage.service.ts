import { Injectable, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Storage as GCSStorage } from '@google-cloud/storage';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly provider: string; // 'gcs' | 's3'
  private readonly s3?: S3Client;
  private readonly gcs?: GCSStorage;

  private readonly bucket: string;
  private readonly region: string;
  private readonly cdnDomain: string;

  private readonly gcsProjectId: string;
  private readonly gcsProductImagesBucket: string;
  private readonly gcsStaticAssetsBucket: string;

  constructor(private readonly config: ConfigService) {
    this.provider = this.config.get<string>('STORAGE_PROVIDER', 'gcs').toLowerCase();

    // GCS Configuration
    this.gcsProjectId = this.config.get<string>('GCS_PROJECT_ID', 'yuzkizi-chat');
    this.gcsProductImagesBucket = this.config.get<string>('GCS_PRODUCT_IMAGES_BUCKET', 'yukiz-bucket');
    this.gcsStaticAssetsBucket = this.config.get<string>('GCS_STATIC_ASSETS_BUCKET', 'yukiz-bucket');

    const rawKeyFilename =
      this.config.get<string>('GOOGLE_APPLICATION_CREDENTIALS') ||
      this.config.get<string>('GCS_KEY_FILE');

    let keyFilename: string | undefined;
    if (rawKeyFilename) {
      const resolved = path.isAbsolute(rawKeyFilename)
        ? rawKeyFilename
        : path.resolve(process.cwd(), rawKeyFilename);

      if (fs.existsSync(resolved)) {
        keyFilename = resolved;
      } else {
        this.logger.warn(`GCS keyfile specified at ${resolved} but file was not found.`);
      }
    }

    try {
      const gcsOpts: any = { projectId: this.gcsProjectId };
      if (keyFilename) {
        gcsOpts.keyFilename = keyFilename;
      }
      this.gcs = new GCSStorage(gcsOpts);
      this.logger.log(`Initialized Google Cloud Storage for project ${this.gcsProjectId} (bucket: ${this.gcsProductImagesBucket}, keyfile: ${keyFilename || 'ADC/Default'})`);
    } catch (gcsErr: any) {
      this.logger.warn(`GCS initialization notice: ${gcsErr.message}`);
    }

    this.cdnDomain = this.config.get<string>(
      'CDN_DOMAIN',
      `https://storage.googleapis.com/${this.gcsProductImagesBucket}`,
    );
  }

  async onModuleInit() {
    if (this.provider === 'gcs' && this.gcs) {
      try {
        await this.gcs.bucket(this.gcsProductImagesBucket).setCorsConfiguration([
          {
            maxAgeSeconds: 3600,
            method: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD', 'OPTIONS'],
            origin: ['*'],
            responseHeader: ['Content-Type', 'Access-Control-Allow-Origin', 'x-goog-resumable'],
          },
        ]);
        this.logger.log(`Successfully configured CORS for GCS bucket: ${this.gcsProductImagesBucket}`);
      } catch (corsErr: any) {
        this.logger.warn(`Notice updating GCS bucket CORS: ${corsErr.message}`);
      }
    }
  }

  private readonly ALLOWED_IMAGE_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/jpg',
    'image/svg+xml',
    'video/mp4',
    'video/webm',
    'video/quicktime',
  ];

  private readonly ALLOWED_DOC_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/svg+xml',
    'application/pdf',
  ];

  private readonly MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB — images and documents

  /**
   * Banner videos. 40 MB is about 20 seconds of decently encoded 1080p, which
   * is longer than any hero banner should be; anything beyond that belongs on a
   * video host, not in the page's critical path.
   */
  private readonly MAX_VIDEO_SIZE = 40 * 1024 * 1024;

  async uploadProductImage(file: Express.Multer.File): Promise<string> {
    this.validateFile(file, this.ALLOWED_IMAGE_TYPES);
    const key = await this.upload(file, 'product-images');
    return this.getFileUrl(key);
  }

  async uploadDrugLicense(file: Express.Multer.File): Promise<string> {
    this.validateFile(file, this.ALLOWED_DOC_TYPES);
    return this.upload(file, 'drug-licenses');
  }

  async uploadPaymentProof(file: Express.Multer.File): Promise<string> {
    this.validateFile(file, this.ALLOWED_DOC_TYPES);
    return this.upload(file, 'payment-proofs');
  }

  async uploadKycDocument(file: Express.Multer.File): Promise<string> {
    this.validateFile(file, this.ALLOWED_DOC_TYPES);
    return this.upload(file, 'kyc-documents');
  }

  async getPresignedUrl(
    key: string,
    expiresIn: number = 3600,
  ): Promise<string> {
    let actualKey = key;
    if (key.startsWith('http')) {
      const parts = key.split('storage.googleapis.com/').concat(key.split('.amazonaws.com/'));
      if (parts.length > 1) {
        actualKey = parts[1].replace(`${this.gcsProductImagesBucket}/`, '');
      }
    }

    if (this.provider === 'gcs' && this.gcs) {
      try {
        const [url] = await this.gcs
          .bucket(this.gcsProductImagesBucket)
          .file(actualKey)
          .getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + expiresIn * 1000,
          });
        return url;
      } catch (err: any) {
        this.logger.warn(`GCS signed URL notice: ${err.message}`);
        return `https://storage.googleapis.com/${this.gcsProductImagesBucket}/${actualKey}`;
      }
    }

    if (this.provider === 'gcs') {
      return `https://storage.googleapis.com/${this.gcsProductImagesBucket}/${actualKey}`;
    }

    if (this.s3) {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: actualKey,
      });
      return getSignedUrl(this.s3, command, { expiresIn });
    }

    return `https://storage.googleapis.com/${this.gcsProductImagesBucket}/${actualKey}`;
  }

  /**
   * Copies an object within the product-images bucket (SEO renames). Returns
   * the new public URL, or null when unsupported/failed. makePublic() mirrors
   * the upload path so ACL-mode buckets serve the copy publicly too.
   */
  async copyObject(oldKey: string, newKey: string): Promise<string | null> {
    if (this.provider !== 'gcs' || !this.gcs) return null;
    try {
      const bucket = this.gcs.bucket(this.gcsProductImagesBucket);
      const [copied] = await bucket.file(oldKey).copy(bucket.file(newKey));
      try {
        await copied.makePublic();
      } catch {
        // Uniform bucket-level access forbids per-object ACLs; the bucket
        // policy already makes it public there.
      }
      return `https://storage.googleapis.com/${this.gcsProductImagesBucket}/${newKey}`;
    } catch (err) {
      this.logger.warn(`copyObject ${oldKey} -> ${newKey} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async generateUploadUrl(
    productId: string | undefined,
    filename: string,
    contentType: string,
  ) {
    const id = productId || `tmp-${randomUUID()}`;
    const folder = contentType.startsWith('video/') ? 'videos' : 'images';
    const cleanName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `media/${folder}/${id}/${cleanName}`;

    const isGcs = this.provider === 'gcs';

    if (isGcs && this.gcs) {
      try {
        const [presignedUrl] = await this.gcs
          .bucket(this.gcsProductImagesBucket)
          .file(key)
          .getSignedUrl({
            version: 'v4',
            action: 'write',
            expires: Date.now() + 10 * 60 * 1000,
            contentType,
          });
        const cdnUrl = `https://storage.googleapis.com/${this.gcsProductImagesBucket}/${key}`;
        return { presigned_url: presignedUrl, key, cdn_url: cdnUrl };
      } catch (err: any) {
        this.logger.warn(`GCS presigned write URL notice: ${err.message}`);
      }
    }

    if (isGcs) {
      const cdnUrl = `https://storage.googleapis.com/${this.gcsProductImagesBucket}/${key}`;
      return {
        presigned_url: cdnUrl,
        key,
        cdn_url: cdnUrl,
      };
    }

    if (this.s3) {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      });
      const presignedUrl = await getSignedUrl(this.s3, command, {
        expiresIn: 600,
        signableHeaders: new Set(['content-type', 'host']),
      });
      const cdnUrl = `${this.cdnDomain}/${key}`;
      return { presigned_url: presignedUrl, key, cdn_url: cdnUrl };
    }

    const cdnUrl = `https://storage.googleapis.com/${this.gcsProductImagesBucket}/${key}`;
    return { presigned_url: cdnUrl, key, cdn_url: cdnUrl };
  }

  async uploadBlogImage(file: Express.Multer.File): Promise<string> {
    this.validateFile(file, this.ALLOWED_IMAGE_TYPES);
    const key = await this.upload(file, 'blog-images');
    return this.getFileUrl(key);
  }

  async uploadBannerImage(file: Express.Multer.File): Promise<string> {
    this.validateFile(file, this.ALLOWED_IMAGE_TYPES);
    const key = await this.upload(file, 'banners');
    return this.getFileUrl(key);
  }

  async uploadSettlementProof(file: Express.Multer.File): Promise<string> {
    this.validateFile(file, this.ALLOWED_DOC_TYPES);
    const key = await this.upload(file, 'settlement-proofs');
    return this.getFileUrl(key);
  }

  async uploadOrderDocument(file: Express.Multer.File): Promise<string> {
    this.validateFile(file, this.ALLOWED_DOC_TYPES);
    const key = await this.upload(file, 'order-documents');
    return this.getFileUrl(key);
  }

  private getFileUrl(key: string): string {
    if (this.provider === 'gcs') {
      return `https://storage.googleapis.com/${this.gcsProductImagesBucket}/${key}`;
    }
    return `${this.cdnDomain}/${key}`;
  }

  private validateFile(
    file: Express.Multer.File,
    allowedTypes: string[],
  ): void {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    if (!allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `Invalid file type: ${file.mimetype}. Allowed: ${allowedTypes.join(', ')}`,
      );
    }

    // A banner video cannot live inside the picture limit — five megabytes is
    // roughly two seconds of 1080p. The ceiling therefore follows the file's
    // own type rather than being one number for everything, so pictures keep
    // exactly the limit they had.
    const limit = file.mimetype.startsWith('video/')
      ? this.MAX_VIDEO_SIZE
      : this.MAX_FILE_SIZE;

    if (file.size > limit) {
      throw new BadRequestException(
        `File too large. Maximum size is ${limit / (1024 * 1024)}MB for ${
          file.mimetype.startsWith('video/') ? 'videos' : 'images'
        }.`,
      );
    }
  }

  private async upload(
    file: Express.Multer.File,
    folder: string,
  ): Promise<string> {
    const ext = file.originalname.split('.').pop() || 'bin';
    const key = `${folder}/${randomUUID()}.${ext}`;

    if (this.provider === 'gcs' && this.gcs) {
      try {
        const bucket = this.gcs.bucket(this.gcsProductImagesBucket);
        const gcsFile = bucket.file(key);

        await gcsFile.save(file.buffer, {
          contentType: file.mimetype,
          resumable: false,
          metadata: {
            cacheControl: 'public, max-age=31536000',
          },
        });

        try {
          await gcsFile.makePublic();
        } catch (aclErr: any) {
          // Ignored if Uniform Bucket-Level Access is enforced
        }

        this.logger.log(`File uploaded to Google Cloud Storage (bucket: ${this.gcsProductImagesBucket}): ${key}`);
        return key;
      } catch (gcsError: any) {
        this.logger.error(`GCS Upload Error: ${gcsError.message}`, gcsError.stack);
        throw new BadRequestException(`Failed to upload file to Google Cloud Storage: ${gcsError.message}`);
      }
    }

    if (this.provider === 'gcs') {
      throw new BadRequestException('Google Cloud Storage client not initialized');
    }

    return this.uploadToS3(file, key);
  }

  private async uploadToS3(file: Express.Multer.File, key: string): Promise<string> {
    if (!this.s3) {
      throw new BadRequestException('Storage service not configured properly');
    }

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    });

    try {
      await this.s3.send(command);
      this.logger.log(`File uploaded to S3: ${key}`);
      return key;
    } catch (error: any) {
      this.logger.error(`S3 Upload Error: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to upload file: ${error.message}`);
    }
  }
}
