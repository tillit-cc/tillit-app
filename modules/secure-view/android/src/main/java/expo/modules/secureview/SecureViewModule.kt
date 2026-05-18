package expo.modules.secureview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SecureViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SecureView")

    View(SecureContainerView::class) {}
  }
}
