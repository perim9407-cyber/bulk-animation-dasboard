const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Endpoint Sistem Musik: Bypass & Publish ke Roblox
app.post('/api/process-and-publish', upload.single('audioFile'), async (req, res) => {
    try {
        const { youtubeUrl, assetName, apiKey, userId } = req.body;
        let inputFilePath = '';
        let outputFilePath = path.join('uploads', `processed_${Date.now()}.mp3`);

        if (youtubeUrl) {
            const rawAudioPath = path.join('uploads', `yt_${Date.now()}.mp3`);
            await new Promise((resolve, reject) => {
                exec(`yt-dlp -x --audio-format mp3 -o "${rawAudioPath}" "${youtubeUrl}"`, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            inputFilePath = rawAudioPath.endsWith('.mp3') ? rawAudioPath : rawAudioPath + '.mp3';
        } else if (req.file) {
            inputFilePath = req.file.path;
        } else {
            return res.status(400).json({ success: false, error: 'Sumber audio tidak ditemukan!' });
        }

        // Modifikasi Audio via FFmpeg agar lolos copyright
        await new Promise((resolve, reject) => {
            exec(`ffmpeg -i "${inputFilePath}" -af "atempo=1.03,asetrate=44100*1.02" "${outputFilePath}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Kirim ke Roblox Open Cloud API
        const form = new FormData();
        const requestMetadata = {
            assetType: "Audio",
            displayName: assetName || "Bypassed Audio Roblox",
            description: "Uploaded via Ultimate Roblox Tool",
            creationContext: { creator: { userId: userId } }
        };

        form.append('request', JSON.stringify(requestMetadata));
        form.append('fileContent', fs.createReadStream(outputFilePath), {
            filename: 'audio.mp3',
            contentType: 'audio/mpeg'
        });

        const robloxRes = await fetch('https://apis.roblox.com/assets/v1/assets', {
            method: 'POST',
            headers: { 'x-api-key': apiKey, ...form.getHeaders() },
            body: form
        });

        const robloxData = await robloxRes.json();

        if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath);
        if (fs.existsSync(outputFilePath)) fs.unlinkSync(outputFilePath);

        if (!robloxRes.ok) {
            return res.status(400).json({ success: false, error: robloxData });
        }

        res.json({ success: true, data: robloxData });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
