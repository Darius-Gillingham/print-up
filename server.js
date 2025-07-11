// File: server.js
// Commit: fix Printify upload by replacing Buffer with fs.createReadStream in form-data

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import FormData from 'form-data';

dotenv.config();

const app = express();
const port = 8081;

app.use(cors());
app.use(express.json());

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  PRINTIFY_API_KEY,
  PRINTIFY_SHOP_ID
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE || !PRINTIFY_API_KEY || !PRINTIFY_SHOP_ID) {
  console.error('❌ Missing environment configuration');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const printifyApiKey = PRINTIFY_API_KEY.trim();
const productId = 5;
const variantId = 40156;
const TEMP_DIR = './tmp';

async function ensureTempDir() {
  try {
    await fs.mkdir(TEMP_DIR);
  } catch (_) {}
}

async function downloadImage(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
  const filePath = path.join(TEMP_DIR, filename);
  const buffer = await res.arrayBuffer();
  await fs.writeFile(filePath, Buffer.from(buffer));
  return filePath;
}

async function uploadImageToPrintify(filePath) {
  const fileStream = fssync.createReadStream(filePath);
  const form = new FormData();

  console.log('⛏️ Using fs.createReadStream for:', filePath);

  try {
    form.append('file', fileStream, {
      filename: 'upload.png',
      contentType: 'image/png'
    });
  } catch (err) {
    console.error('🧨 form.append crash:', err.stack || err);
    throw err;
  }

  const response = await fetch(
    'https://api.printify.com/v1/uploads/images.json',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${printifyApiKey}`,
        ...form.getHeaders()
      },
      body: form
    }
  );

  if (!response.ok) {
    const errorData = await response.json();
    console.error('✗ Printify upload rejected:', JSON.stringify(errorData, null, 2));
    throw new Error(`Printify image upload failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.id;
}

async function uploadNextImageToPrintify() {
  console.log('🔁 Polling Supabase for unprocessed image...');

  try {
    const { data, error } = await supabase
      .from('image_index')
      .select('id, path')
      .eq('printify_uploaded', false)
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      console.error('✗ Supabase error:', error.message);
      return;
    }

    if (!data || data.length === 0) {
      console.log('⏳ No unprocessed images found.');
      return;
    }

    const image = data[0];
    const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/generated-images/${image.path}`;
    const filename = image.path.split('/').pop();
    const title = `Auto Product: ${filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`;
    const localPath = path.join(TEMP_DIR, filename);

    console.log(`⬇️  Downloading image: ${imageUrl}`);
    await ensureTempDir();
    const filePath = await downloadImage(imageUrl, filename);

    console.log(`☁️  Uploading to Printify from: ${filePath}`);
    const printifyImageId = await uploadImageToPrintify(filePath);

    console.log(`📦 Creating product "${title}" with image_id: ${printifyImageId}`);

    const createResponse = await fetch(`https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/products.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${printifyApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title,
        description: "Auto-generated product from Supabase",
        blueprint_id: productId,
        variants: [
          {
            id: variantId,
            price: 2500,
            is_enabled: true
          }
        ],
        print_areas: [
          {
            variant_ids: [variantId],
            placeholders: [
              {
                position: "front",
                images: [
                  {
                    id: printifyImageId
                  }
                ]
              }
            ]
          }
        ]
      })
    });

    const result = await createResponse.json();

    if (!createResponse.ok) {
      console.error(`✗ Printify product creation error [${createResponse.status}]:`, JSON.stringify(result, null, 2));
      return;
    }

    console.log(`✓ Uploaded "${title}" → product_id: ${result.id}`);

    await fs.unlink(filePath);
    console.log(`🗑️  Deleted local file: ${filePath}`);

    const { error: updateError } = await supabase
      .from('image_index')
      .update({ printify_uploaded: true })
      .eq('id', image.id);

    if (updateError) {
      console.error('✗ Supabase update error:', updateError.message);
    } else {
      console.log(`✅ Marked image ID ${image.id} as uploaded.`);
    }
  } catch (err) {
    console.error('✗ Pipeline error:', err.message);
  }
}

setInterval(uploadNextImageToPrintify, 5000);

app.get('/health', (_, res) => {
  res.send('✓ Printify auto-uploader is alive');
});

app.listen(port, () => {
  console.log(`✓ server.js auto-looping on port ${port}`);
});
