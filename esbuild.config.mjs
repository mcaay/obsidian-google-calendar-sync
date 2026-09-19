import esbuild from 'esbuild';
import { builtinModules } from 'node:module';

const production = process.argv.includes('production');
const options = {
    entryPoints: ['src/main.ts'],
    bundle: true,
    external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules, ...builtinModules.map(name => `node:${name}`)],
    format: 'cjs',
    target: 'es2022',
    platform: 'node',
    outfile: 'main.js',
    sourcemap: production ? false : 'inline',
    minify: production,
    logLevel: 'info',
};
if (production) await esbuild.build(options);
else {
    const context = await esbuild.context(options);
    await context.watch();
}
