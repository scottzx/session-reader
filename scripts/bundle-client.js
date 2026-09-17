import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dshEntry = path.resolve(__dirname, '../src/dsh/client.ts');
const dshOut = path.resolve(__dirname, '../dist/src/dsh/client.js');
const webEntry = path.resolve(__dirname, '../src/web/app.ts');
const webOut = path.resolve(__dirname, '../dist/src/web/app.js');

const browserBuild = {
  bundle: true,
  platform: 'browser',
  target: ['es2022'],
  loader: { '.ts': 'ts' },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
};

try {
  const result = esbuild.buildSync({
    ...browserBuild,
    entryPoints: [dshEntry],
    format: 'cjs',
    write: false,
  });

  if (!result.outputFiles?.length) throw new Error('esbuild produced no DSH client output');
  const wrapped = `window.__ModuleLoader__.load({
  id: "@1agents/session-reader",
  factory: (_require) => {
    var module = { exports: {} };
    var exports = module.exports;

${result.outputFiles[0].text.trim()}
    return module.exports;
  }
});
`;
  fs.mkdirSync(path.dirname(dshOut), { recursive: true });
  fs.writeFileSync(dshOut, wrapped, 'utf8');
  console.log('Successfully bundled dist/src/dsh/client.js with @1agents/chat-ui for DSH browser module loader!');

  fs.mkdirSync(path.dirname(webOut), { recursive: true });
  esbuild.buildSync({
    ...browserBuild,
    entryPoints: [webEntry],
    format: 'iife',
    outfile: webOut,
  });
  console.log('Successfully bundled dist/src/web/app.js for `1session web`');
} catch (err) {
  console.error('Bundle client error:', err);
  process.exit(1);
}
