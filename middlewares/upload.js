const multer = require('multer');
const path = require('path');

/**
 * Multer configured with in-memory storage.
 * The file buffer (req.file.buffer) is then uploaded to S3 in the controller.
 *
 * Why memory storage?
 *   Disk storage writes to the local server's filesystem, which breaks when
 *   running multiple instances — instance 2 can't serve a file uploaded to
 *   instance 1. S3 (or R2) is the correct solution for shared, durable storage.
 */
const fileFilter = (_req, file, cb) => {
  const allowedExt = /jpeg|jpg|png|webp/;
  const allowedMime = /image\/(jpeg|png|webp)/;
  const extOk = allowedExt.test(path.extname(file.originalname).toLowerCase());
  const mimeOk = allowedMime.test(file.mimetype);
  if (extOk && mimeOk) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, and WebP images are allowed.'));
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

module.exports = upload;
