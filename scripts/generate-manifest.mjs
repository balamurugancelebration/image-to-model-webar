import fs from 'node:fs';
import path from 'node:path';

const targetDir = path.resolve('public/targets');
const modelDir = path.resolve('public/3d');
const outputFile = path.resolve('public/config/targets.json');
const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const modelExts = new Set(['.glb', '.gltf']);

const files = (dir, exts) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && exts.has(path.extname(entry.name).toLowerCase()))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

let previous = { targets: [], tracking: { filterMinCF: 0.001, filterBeta: 10 } };
try { previous = JSON.parse(fs.readFileSync(outputFile, 'utf8')); } catch {}
const previousByName = new Map((previous.targets || []).map((target) => [target.name.toLowerCase(), target]));
const images = files(targetDir, imageExts);
const models = files(modelDir, modelExts);
const modelByStem = new Map(models.map((name) => [path.parse(name).name.toLowerCase(), name]));
const missing = [];
const targets = [];

for (const image of images) {
  const stem = path.parse(image).name;
  const model = modelByStem.get(stem.toLowerCase());
  if (!model) {
    missing.push(image);
    continue;
  }
  const old = previousByName.get(stem.toLowerCase()) || {};
  targets.push({
    name: stem,
    imageFile: image,
    modelFile: model,
    modelUrl: `./3d/${encodeURIComponent(model).replaceAll('%2F', '/')}`,
    targetIndex: targets.length,
    position: old.position || '0 0 0',
    rotation: old.rotation || '0 0 0',
    scale: old.scale || '0.2 0.2 0.2',
    surface: old.surface || 'wall'
  });
}

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: 'targetIndex order is alphabetical by target filename. Compile target images in exactly this order.',
  tracking: previous.tracking || { filterMinCF: 0.001, filterBeta: 10 },
  targets
}, null, 2) + '\n');

console.log(`Generated ${path.relative(process.cwd(), outputFile)} with ${targets.length} image/model pair(s).`);
if (missing.length) console.warn(`No matching 3D model found for: ${missing.join(', ')}`);
if (!images.length) console.warn('No target images found in public/targets.');
if (!models.length) console.warn('No 3D models found in public/3d.');
if (targets.length) {
  console.log('\\nCompile your target images in this exact order:');
  targets.forEach((target) => console.log(`  ${target.targetIndex}: ${target.imageFile} -> ${target.modelFile}`));
}
