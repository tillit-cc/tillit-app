Pod::Spec.new do |s|
  s.name           = 'SecureView'
  s.version        = '1.0.0'
  s.summary        = 'Screenshot-proof view for React Native/Expo'
  s.description    = 'Renders children inside a secure layer that appears black in screenshots and screen recordings'
  s.author         = 'TilliT'
  s.homepage       = 'https://tillit.cc'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.swift'
end
