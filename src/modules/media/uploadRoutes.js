const express = require('express');
const router = express.Router();
const multer = require('multer');

const uploadController = require('./uploadController');
const authMiddleware = require('../../common/middlewares/authMiddleware');

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: 100 * 1024 * 1024,
	},
});

router.post('/direct', authMiddleware, upload.single('file'), uploadController.uploadDirect);

module.exports = router;
