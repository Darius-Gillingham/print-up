// File: server.js
// Commit: fallback to blueprint_id 1 and auto-detect first valid provider and variant

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import fs from 'fs/promises';
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

async function uploadImageToPrintifyURL(publicUrl) {
  const form = new FormData();
  form.append('file_name', 'upload.png');
  form.append('url', publicUrl);

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

async function getFirstValidVariant(blueprintId) {
  const providersRes = await fetch(`https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers.json`, {
    headers: { Authorization: `Bearer ${printifyApiKey}` }
  });
  const providers = await providersRes.json();
  if (!Array.isArray(providers) || providers.length === 0) throw new Error('No print providers found');

  const providerId = providers[0].id;

  const variantsRes = await fetch(`https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`, {
    headers: { Authorization: `Bearer ${printifyApiKey}` }
  });
  const variants = await variantsRes.json();
  if (!Array.isArray(variants) || variants.length === 0) throw new Error('No variants found for blueprint/provider');

  return {
    providerId,
    variantId: variants[0].id
  };
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

    console.log(`⬇️  Supabase public image URL: ${imageUrl}`);
    console.log(`🌐 Uploading to Printify via URL: ${imageUrl}`);
    const printifyImageId = await uploadImageToPrintifyURL(imageUrl);

    const blueprintId = 1;
    const { providerId, variantId } = await getFirstValidVariant(blueprintId);

    console.log(`📦 Creating product "${title}" with image_id: ${printifyImageId}`);

    const createResponse = await fetch(`https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/products.json`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${printifyApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title,
        description: 'Auto-generated product from Supabase',
        blueprint_id: blueprintId,
        print_provider_id: providerId,
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
                position: 'front',
                images: [
                  {
                    id: printifyImageId,
                    x: 0,
                    y: 0,
                    scale: 1,
                    angle: 0
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
