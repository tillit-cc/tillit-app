const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const LIBSIGNAL_TAG = 'v0.86.9';
const LIBSIGNAL_FFI_CHECKSUM =
  'f999674d333cf461dc0dff274325104967a76d501cc209d1df6c40cf31ff2988';

/**
 * Expo config plugin for LibSignalClient (iOS + Android).
 *
 * iOS:  Injects the LibSignalClient pod from Signal's GitHub repo into the
 *       Podfile, plus post-install hooks for FFI linking.
 *
 * Android: Enables core library desugaring in the app-level build.gradle,
 *          required by libsignal-android and the signal-protocol Expo module.
 */
const withLibSignalClient = (config) => {
  // --- Android: enable coreLibraryDesugaring in the app ---
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const buildGradlePath = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'build.gradle'
      );
      let buildGradle = fs.readFileSync(buildGradlePath, 'utf8');

      // 1. Add compileOptions with coreLibraryDesugaringEnabled (skip if already present)
      if (!buildGradle.includes('coreLibraryDesugaringEnabled')) {
        buildGradle = buildGradle.replace(
          /android\s*\{/,
          `android {\n    compileOptions {\n        coreLibraryDesugaringEnabled true\n    }\n`
        );
      }

      // 2. Add coreLibraryDesugaring dependency (skip if already present)
      if (!buildGradle.includes("coreLibraryDesugaring '") && !buildGradle.includes('coreLibraryDesugaring "')) {
        buildGradle = buildGradle.replace(
          /dependencies\s*\{/,
          `dependencies {\n    coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.0.3'`
        );
      }

      fs.writeFileSync(buildGradlePath, buildGradle);
      return config;
    },
  ]);

  // --- iOS: inject LibSignalClient pod + FFI hooks ---
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(
        config.modRequest.platformProjectRoot,
        'Podfile'
      );
      let podfile = fs.readFileSync(podfilePath, 'utf8');

      // Skip if already patched
      if (podfile.includes('LibSignalClient')) {
        return config;
      }

      // Derive app target name from the Podfile (e.g. "tillitnative")
      const targetMatch = podfile.match(/target ['"](\w+)['"]\s+do/);
      const appTarget = targetMatch ? targetMatch[1] : 'tillitnative';

      // 1. Add FFI checksum env var before the target block
      podfile = podfile.replace(
        /^(prepare_react_native_project!\n)/m,
        `$1\n# LibSignalClient FFI prebuild checksum (required for signal-protocol module)\nENV['LIBSIGNAL_FFI_PREBUILD_CHECKSUM'] = '${LIBSIGNAL_FFI_CHECKSUM}'\n`
      );

      // 2. Add pod declaration right after use_expo_modules!
      podfile = podfile.replace(
        /(use_expo_modules!\n)/,
        `$1\n  # LibSignalClient from Signal's repo (not available on CocoaPods registry)\n  pod 'LibSignalClient', git: 'https://github.com/signalapp/libsignal.git', tag: '${LIBSIGNAL_TAG}'\n`
      );

      // 3. Add post_install hooks after react_native_post_install block
      const postInstallHooks = `
    # LibSignalClient: set FFI prebuild checksum
    installer.pods_project.targets.each do |target|
      next unless target.name == 'LibSignalClient'
      target.build_configurations.each do |build_config|
        build_config.build_settings['LIBSIGNAL_FFI_PREBUILD_CHECKSUM'] = ENV['LIBSIGNAL_FFI_PREBUILD_CHECKSUM']
      end
    end

    # SignalProtocol: add LibSignalClient FFI headers to Swift include paths
    installer.pods_project.targets.each do |target|
      next unless target.name == 'SignalProtocol'
      target.build_configurations.each do |build_config|
        include_path = '$(PODS_ROOT)/LibSignalClient/swift/Sources/SignalFfi'
        current = build_config.build_settings['SWIFT_INCLUDE_PATHS'] || '$(inherited)'
        unless current.include?(include_path)
          build_config.build_settings['SWIFT_INCLUDE_PATHS'] = "#{current} #{include_path}"
        end
      end
    end

    # Fix signal_ffi auto-linking for the app target.
    # LibSignalClient's modulemap has \`link "signal_ffi"\` which generates -lsignal_ffi.
    # Without use_frameworks!, linking happens at the app target level. The linker needs
    # to find libsignal_ffi.a, which is extracted by LibSignalClient's script phases
    # into architecture-specific directories under the Pods project temp dir.
    #
    # We add a script phase that symlinks the correct .a into a fixed directory,
    # and add that directory to LIBRARY_SEARCH_PATHS.
    ffi_link_dir = '$(OBJROOT)/libsignal_ffi_current'

    # Add the fixed directory to LIBRARY_SEARCH_PATHS in the aggregate xcconfig
    installer.aggregate_targets.each do |aggregate_target|
      aggregate_target.xcconfigs.each do |config_name, config_file|
        current_paths = config_file.attributes['LIBRARY_SEARCH_PATHS'] || '$(inherited)'
        unless current_paths.include?('libsignal_ffi_current')
          config_file.attributes['LIBRARY_SEARCH_PATHS'] = "#{current_paths} \\"#{ffi_link_dir}\\""
        end
        xcconfig_path = aggregate_target.xcconfig_path(config_name)
        config_file.save_as(xcconfig_path)
      end
    end

    # Add a script phase to the app target that symlinks the correct architecture's .a
    user_project = installer.aggregate_targets.first.user_project
    user_project.targets.each do |target|
      next unless target.name == '${appTarget}'

      # Remove old phase if it exists (idempotent)
      target.shell_script_build_phases.each do |phase|
        if phase.name == 'Setup LibSignalClient FFI'
          target.build_phases.delete(phase)
        end
      end

      phase = target.new_shell_script_build_phase('Setup LibSignalClient FFI')
      phase.shell_script = %q(
set -euo pipefail
FFI_DIR="\${OBJROOT}/Pods.build/libsignal_ffi/target"
LINK_DIR="\${OBJROOT}/libsignal_ffi_current"
rm -rf "\${LINK_DIR}"
mkdir -p "\${LINK_DIR}"

if [ "\${PLATFORM_NAME}" = "iphonesimulator" ]; then
  if [ "\${CURRENT_ARCH}" = "arm64" ] || [ "\${ARCHS}" = "arm64" ]; then
    SRC_DIR="\${FFI_DIR}/aarch64-apple-ios-sim/release"
  else
    SRC_DIR="\${FFI_DIR}/x86_64-apple-ios/release"
  fi
else
  SRC_DIR="\${FFI_DIR}/aarch64-apple-ios/release"
fi

if [ -d "\${SRC_DIR}" ]; then
  ln -sf "\${SRC_DIR}/libsignal_ffi.a" "\${LINK_DIR}/libsignal_ffi.a"
  echo "Linked libsignal_ffi.a from \${SRC_DIR}"
else
  echo "warning: libsignal_ffi source directory not found: \${SRC_DIR}" >&2
fi
)
      # Move script phase to be first (before compile)
      target.build_phases.unshift(target.build_phases.delete(phase))
    end
    user_project.save
`;

      // Insert after the react_native_post_install(...) closing paren.
      // The call spans multiple lines and contains nested parens like
      // ccache_enabled?(podfile_properties), so we match lazily up to
      // a closing paren on its own line.
      podfile = podfile.replace(
        /(react_native_post_install\([\s\S]*?\n\s*\))/,
        `$1\n${postInstallHooks}`
      );

      fs.writeFileSync(podfilePath, podfile);
      return config;
    },
  ]);

  return config;
};

module.exports = withLibSignalClient;