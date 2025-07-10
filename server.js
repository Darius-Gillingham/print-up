// File: s5/server.js
// Commit: send Supabase image to Printify with filename-derived auto title

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

app.get('/api/send-to-printify', async (req, res) => {
  try {
    // Step 1: Pull the most recent image
    const { data, error } = await supabase
      .from('image_index')
      .select('path')
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) throw new Error('No image found');

    const imagePath = data[0].path;
    const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/generated-images/${imagePath}`;

    // Step 2: Generate title from file name
    const filename = imagePath.split('/').pop().replace(/\.[^/.]+$/, '');
    const title = `Auto Product: ${filename.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`;

    // Step 3: Send to Printify
    const productId = 5;      // placeholder blueprint ID
    const variantId = 40156;  // placeholder variant ID

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
      throw new Error(`Printify error: ${JSON.stringify(result)}`);
    }

    console.log(`✓ Uploaded to Printify as "${title}"`);
    res.json({ success: true, product: result });
  } catch (err) {
    console.error('✗ Error sending image to Printify:', err.message);
    res.status(500).json({ error: 'Failed to send image to Printify' });
  }
});

app.get('/health', (_, res) => {
  res.send('✓ Printify backend is alive');
});

app.listen(port, () => {
  console.log(`✓ server.js listening on port ${port}`);
});
