const { S3Client } = require('@aws-sdk/client-s3');
const logger = require('../utils/logger');

const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.AWS_REGION || 'us-east-1';

// S3_PUBLIC_URL overrides the default AWS URL — set this for Cloudflare R2 or a CDN.
// For standard AWS S3: leave unset, the default https://{bucket}.s3.{region}.amazonaws.com is used.
// For Cloudflare R2: set to https://{account-id}.r2.cloudflarestorage.com/{bucket}
//                    or your custom domain: https://cdn.yourdomain.com
const S3_PUBLIC_URL =
  process.env.S3_PUBLIC_URL ||
  `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;

if (!process.env.AWS_ACCESS_KEY_ID || !S3_BUCKET) {
  logger.warn('S3 config incomplete — profile picture uploads will fail. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and S3_BUCKET in .env');
}

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
  // For Cloudflare R2 or other S3-compatible services, set S3_ENDPOINT in .env
  ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
});

module.exports = { s3, S3_BUCKET, S3_PUBLIC_URL };
