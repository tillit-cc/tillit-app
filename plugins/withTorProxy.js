const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin for the tor-proxy native module.
 *
 * Android:
 *   1. Adds Guardian Project Maven repository to root build.gradle
 *   2. Creates network_security_config.xml (release) allowing cleartext for:
 *      - localhost / 127.0.0.1 (Tor SOCKS proxy)
 *      - .onion domains (encrypted by Tor circuit, not TLS)
 *   3. Creates a permissive network_security_config.xml in src/debug/res/xml
 *      so debug builds can talk to LAN dev servers (e.g. 192.168.x.x). Android
 *      merges debug resources over main: in release the strict policy wins, in
 *      debug we allow any cleartext host. usesCleartextTraffic in the debug
 *      manifest alone is not enough because Network Security Config takes
 *      priority on API 24+.
 *   4. Adds networkSecurityConfig to AndroidManifest.xml
 *
 * iOS:
 *   No changes needed — arti.xcframework is vendored in the module.
 */
const withTorProxy = (config) => {
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const platformRoot = config.modRequest.platformProjectRoot;

      // 1. Add Guardian Project Maven to root build.gradle
      const rootBuildGradlePath = path.join(platformRoot, 'build.gradle');
      let rootBuildGradle = fs.readFileSync(rootBuildGradlePath, 'utf8');

      if (!rootBuildGradle.includes('guardianproject')) {
        rootBuildGradle = rootBuildGradle.replace(
          /(allprojects\s*\{[\s\S]*?repositories\s*\{[\s\S]*?)((\s*)\}(\s*)\})/,
          (match, before, closingBraces, indent) => {
            return `${before}${indent}  // Guardian Project Maven — hosts tor-android\n${indent}  maven { url 'https://raw.githubusercontent.com/guardianproject/gpmaven/master' }\n${closingBraces}`;
          }
        );
        fs.writeFileSync(rootBuildGradlePath, rootBuildGradle);
      }

      // 2. Create network_security_config.xml (release / main)
      const xmlDir = path.join(platformRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, 'network_security_config.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">localhost</domain>
        <domain includeSubdomains="true">onion</domain>
    </domain-config>
</network-security-config>
`
      );

      // 2b. Create a permissive debug-only override in src/<debug-variant>/res/xml.
      // Android resource merger picks this up only for the debug build types,
      // so dev builds can connect to LAN servers (192.168.x.x, 10.x, ...) by IP.
      const debugNsc = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`;
      for (const variant of ['debug', 'debugOptimized']) {
        const xmlDirVariant = path.join(platformRoot, 'app', 'src', variant, 'res', 'xml');
        fs.mkdirSync(xmlDirVariant, { recursive: true });
        fs.writeFileSync(
          path.join(xmlDirVariant, 'network_security_config.xml'),
          debugNsc,
        );
      }

      // 3. Add networkSecurityConfig to AndroidManifest.xml
      const manifestPath = path.join(platformRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
      let manifest = fs.readFileSync(manifestPath, 'utf8');

      if (!manifest.includes('networkSecurityConfig')) {
        manifest = manifest.replace(
          '<application',
          '<application android:networkSecurityConfig="@xml/network_security_config"'
        );
        fs.writeFileSync(manifestPath, manifest);
      }

      return config;
    },
  ]);

  return config;
};

module.exports = withTorProxy;