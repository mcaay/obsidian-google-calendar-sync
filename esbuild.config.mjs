import esbuild from 'esbuild';

const production = process.argv.includes('production');
const options = {
    entryPoints: ['src/main.ts'],
    bundle: true,
    external: ['obsidian', 'node:http', '@codemirror/*', '@lezer/*'],
    format: 'cjs',
    target: 'es2022',
    platform: 'browser',
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
