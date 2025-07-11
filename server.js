// File: server.js
// Commit: fetch print provider for blueprint dynamically to avoid 404 error on product creation

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import path from 'path';
import dotenv from 'dotenv';

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
const productId = 5; // This remains static
let providerId = null;
let variantId = null;

async function fetchProviderAndVariantForBlueprint(blueprintId) {
  const providerRes = await fetch(`https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers.json`, {
    headers: { Authorization: `Bearer ${printifyApiKey}` }
  });

  if (!providerRes.ok) throw new Error(`Provider fetch failed: ${providerRes.statusText}`);
  const providers = await providerRes.json();
  const provider = providers?.[0];
  if (!provider) throw new Error('No print providers found for blueprint');

  const variantRes = await fetch(`https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${provider.id}/variants.json`, {
    headers: { Authorization: `Bearer ${printifyApiKey}` }
  });

  if (!variantRes.ok) throw new Error(`Variant fetch failed: ${variantRes.statusText}`);
  const variants = await variantRes.json();
  const variant = variants?.[0];
  if (!variant) throw new Error('No variants found for blueprint/provider');

  return { providerId: provider.id, variantId: variant.id };
}

async function uploadImageToPrintifyByUrl(publicUrl, fileName) {
  console.log(`🌐 Uploading to Printify via URL: ${publicUrl}`);

  const response = await fetch(
    'https://api.printify.com/v1/uploads/images.json',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${printifyApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: publicUrl,
        file_name: fileName
      })
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
    const filename = image.path.split('/').pop() || 'upload.png';
    const title = `Auto Product: ${filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`;

    console.log(`⬇️  Supabase public image URL: ${imageUrl}`);
    const printifyImageId = await uploadImageToPrintifyByUrl(imageUrl, filename);

    if (!providerId || !variantId) {
      const result = await fetchProviderAndVariantForBlueprint(productId);
      providerId = result.providerId;
      variantId = result.variantId;
      console.log(`📦 Selected provider: ${providerId}, variant: ${variantId}`);
    }

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
                position: "front",
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
