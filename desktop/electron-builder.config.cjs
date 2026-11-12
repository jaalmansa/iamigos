// electron-builder: a zip per platform and architecture, named the way the
// installer (bin/iamigos.mjs) downloads it from the GitHub Release:
//   IAmigos-<version>-mac-<arch>.zip, IAmigos-<version>-win-<arch>.zip
// The version always comes from the root package.json (the npm package).
const {version} = require('../package.json');

module.exports = {
    appId: 'io.github.jaalmansa.iamigos',
    productName: 'IAmigos',
    extraMetadata: {version},
    directories: {output: 'dist'},
    files: ['src/**/*', 'package.json'],
    artifactName: 'IAmigos-${version}-${os}-${arch}.${ext}',
    mac: {
        target: [{target: 'zip', arch: ['arm64', 'x64']}],
        category: 'public.app-category.developer-tools',
        // A menu bar app: no Dock icon, no app menu.
        extendInfo: {LSUIElement: true},
        // No Apple Developer ID yet: ad-hoc signature, which Apple Silicon needs to
        // run the app at all. Without the hardened runtime, as it is not notarized.
        identity: '-',
        hardenedRuntime: false,
    },
    win: {
        target: [{target: 'zip', arch: ['x64', 'arm64']}],
    },
};
