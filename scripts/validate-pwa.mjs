import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = process.cwd();
const manifestPath = resolve(root, 'public/manifest.webmanifest');
const indexPath = resolve(root, 'index.html');
const serviceWorkerPath = resolve(root, 'public/sw.js');
if (!existsSync(serviceWorkerPath)) throw new Error('public/sw.js is missing.');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const index = readFileSync(indexPath, 'utf8');
const serviceWorker = readFileSync(serviceWorkerPath, 'utf8');
const ocrAssets = {
  'vendor/tesseract/worker.min.js': '38645599043239c0eb6db08a6504a92dcdc292200535f3e9339cd77c4443b842',
  'vendor/tesseract/core/tesseract-core-lstm.wasm.js': '775a35df6f2ae100e02609443e6bd5cafcd07983dd6175454ca4a432a7730687',
  'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js': '9d7c43fb206dc9f48475228b46bf35f888fa9e6259da2e67d5a75c77049f2dc7',
  'vendor/tesseract/lang/eng.traineddata.gz': '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
};

if (manifest.start_url !== './' || manifest.scope !== './' || manifest.display !== 'standalone') {
  throw new Error('PWA manifest must retain relative GitHub Pages scope and standalone display.');
}
if (!index.includes('apple-touch-icon') || !index.includes('apple-mobile-web-app-capable')) {
  throw new Error('Apple web-app metadata is incomplete.');
}
if (!serviceWorker.includes('key.startsWith(CACHE_PREFIX)')) {
  throw new Error('Service worker cache cleanup must be scoped to PetOR caches on shared GitHub Pages origins.');
}

for (const icon of manifest.icons ?? []) {
  const iconPath = resolve(root, 'public', icon.src.replace(/^\.\//, ''));
  if (!existsSync(iconPath)) throw new Error(`Missing manifest icon: ${icon.src}`);
  if (icon.type === 'image/png' && /^\d+x\d+$/.test(icon.sizes)) {
    const bytes = readFileSync(iconPath);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (`${width}x${height}` !== icon.sizes) {
      throw new Error(`Manifest icon ${icon.src} is ${width}x${height}, expected ${icon.sizes}.`);
    }
  }
}

for (const [relativePath, expectedHash] of Object.entries(ocrAssets)) {
  const assetPath = resolve(root, 'public', relativePath);
  if (!existsSync(assetPath)) throw new Error(`Missing offline OCR asset: ${relativePath}`);
  const actualHash = createHash('sha256').update(readFileSync(assetPath)).digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error(`Offline OCR asset checksum mismatch: ${relativePath}`);
  }
  if (!serviceWorker.includes(`./${relativePath}`)) {
    throw new Error(`Offline OCR asset is not precached by public/sw.js: ${relativePath}`);
  }
}

console.log(`PWA assets OK: ${manifest.icons.length} icons and ${Object.keys(ocrAssets).length} offline OCR assets`);
