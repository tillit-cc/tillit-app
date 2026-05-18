Pod::Spec.new do |s|
  s.name           = 'SignalProtocol'
  s.version        = '1.0.0'
  s.summary        = 'Signal Protocol implementation for React Native/Expo'
  s.description    = 'End-to-end encryption using Signal Protocol with LibSignalClient'
  s.author         = 'TilliT'
  s.homepage       = 'https://tillit.cc'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'LibSignalClient', '~> 0.86.9'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.swift'
end
