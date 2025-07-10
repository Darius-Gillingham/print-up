// File: print-up/server.js
// Commit: Added verbose debug logging for Supabase→Printify upload pipeline

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
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

const productId = 5;      // Replace with actual blueprint ID
const variantId = 40156;  // Replace with actual variant ID

async function uploadNextImageToPrintify() {
  console.log('🔍 Querying Supabase for unprocessed images...');

  const { data, error } = await supabase
    .from('image_index')
    .select('id, path')
    .eq('printify_uploaded', false)
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    console.error('✗ Supabase query error:', error.message, error.details || '');
    return;
  }

  if (!data || data.length === 0) {
    console.log('⏳ No unprocessed images found.');
    return;
  }

  const image = data[0];
  console.log(`🖼 Found image ID ${image.id} → ${image.path}`);

  const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/generated-images/${image.path}`;
  const filename = image.path.split('/').pop().replace(/\.[^/.]+$/, '');
  const title = `Auto Product: ${filename.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`;

  console.log(`📤 Uploading to Printify: ${title}`);
  console.log(`🔗 Image URL: ${imageUrl}`);

  try {
    const response = await fetch(`https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/products.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PRINTIFY_API_KEY}`,
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
                    src: imageUrl,
                    x: 0.5,
                    y: 0.5,
                    scale: 1.0,
                    angle: 0
                  }
                ]
              }
            ]
          }
        ]
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error(`✗ Printify error [${response.status}]:`, JSON.stringify(result, null, 2));
      return;
    }

    console.log(`✓ Uploaded "${title}" → product_id: ${result.id}`);

    const { error: updateError } = await supabase
      .from('image_index')
      .update({ printify_uploaded: true })
      .eq('id', image.id);

    if (updateError) {
      console.error('✗ Supabase update error:', updateError.message, updateError.details || '');
    } else {
      console.log(`✅ Marked image ID ${image.id} as uploaded.`);
    }
  } catch (err) {
    console.error('✗ Upload failed with exception:', err.message);
  }
}

// Add heartbeat log every 5s
setInterval(() => {
  console.log('🔁 Polling loop tick...');
  uploadNextImageToPrintify();
}, 5000);

app.get('/health', (_, res) => {
  res.send('✓ Printify auto-uploader is alive');
});

app.listen(port, () => {
  console.log(`✓ server.js auto-looping on port ${port}`);
});
