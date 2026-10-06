const uploadService = require('./uploadService');

async function uploadDirect(req, res) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'Vui lòng chọn tệp cần tải lên' });
    }

    const { keyPrefix, folder } = req.body || {};
    const result = await uploadService.uploadBufferDirect({
      keyPrefix: keyPrefix || folder,
      contentType: req.file.mimetype,
      buffer: req.file.buffer,
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

module.exports = { uploadDirect };
