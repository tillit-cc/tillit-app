import ExpoModulesCore

public class SecureViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SecureView")

    View(SecureContainerView.self) {}
  }
}
