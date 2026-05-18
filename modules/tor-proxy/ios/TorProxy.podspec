Pod::Spec.new do |s|
  s.name           = 'TorProxy'
  s.version        = '1.0.0'
  s.summary        = 'Tor embedded proxy for React Native/Expo'
  s.description    = 'Provides HTTP and WebSocket connectivity via Tor hidden services (.onion) using Arti with onion-service-client'
  s.author         = 'TilliT'
  s.homepage       = 'https://tillit.cc'
  s.platforms      = { :ios => '15.0' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Custom-built arti.xcframework with onion-service-client Cargo feature.
  # Built via scripts/build-arti-xcframework.sh
  s.vendored_frameworks = 'arti.xcframework'

  s.source_files = '**/*.{swift,m,h}'
  s.public_header_files = 'ArtiWrapper.h'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/arti.xcframework/ios-arm64/arti.framework/Headers"',
  }
end