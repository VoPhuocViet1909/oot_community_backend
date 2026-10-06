const cloudinary = require("../../config/cloudinaryConfig");
const { randomUUID } = require("crypto");

function guessResourceType(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return "auto";
}

/**
 * Uploads a buffer to Cloudinary. Shared by the generic /api/uploads/direct
 * endpoint and the message-file-attachment upload path.
 */
async function uploadBuffer({ buffer, keyPrefix, contentType }) {
  const folder = keyPrefix || "uploads";
  const resourceType = guessResourceType(contentType);

  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: randomUUID(),
        resource_type: resourceType,
      },
      (error, uploadResult) => {
        if (error) return reject(error);
        resolve(uploadResult);
      },
    );
    stream.end(buffer);
  });

  return {
    key: result.public_id,
    url: result.secure_url,
    resourceType: result.resource_type,
  };
}

async function uploadBufferDirect({ keyPrefix, contentType, buffer }) {
  const { key, url, resourceType } = await uploadBuffer({ buffer, keyPrefix, contentType });
  return { key, url, bucket: resourceType };
}

module.exports = {
  uploadBuffer,
  uploadBufferDirect,
};
