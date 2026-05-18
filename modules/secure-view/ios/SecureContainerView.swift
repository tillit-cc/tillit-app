import ExpoModulesCore
import UIKit

/// A view that renders its children inside a secure UITextField layer.
/// Content appears black in screenshots and screen recordings on iOS
/// thanks to the `isSecureTextEntry` trick — the OS redacts the
/// internal layer of secure text fields in capture output.
class SecureContainerView: ExpoView {
  private let secureField = UITextField()
  private var secureContainer: UIView?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    setupSecureLayer()
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  private func setupSecureLayer() {
    secureField.isSecureTextEntry = true
    secureField.isUserInteractionEnabled = false
    addSubview(secureField)

    secureField.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      secureField.topAnchor.constraint(equalTo: topAnchor),
      secureField.bottomAnchor.constraint(equalTo: bottomAnchor),
      secureField.leadingAnchor.constraint(equalTo: leadingAnchor),
      secureField.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])

    // Force layout so UITextField creates its internal _UITextFieldContentView immediately.
    // This avoids the race condition where children arrive before the container is ready.
    secureField.layoutIfNeeded()

    if let container = secureField.subviews.first {
      secureContainer = container
      container.isUserInteractionEnabled = true
    } else {
      // Fallback: wait for next run loop iteration
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        if let container = self.secureField.subviews.first {
          self.secureContainer = container
          container.isUserInteractionEnabled = true

          // Move any children that were added before the container was ready
          for subview in self.subviews where subview !== self.secureField {
            container.addSubview(subview)
          }
        }
      }
    }
  }

  // MARK: - Fabric child management

  // Override Fabric's mount/unmount to place children inside the secure container
  // instead of as direct subviews. The base RCTViewComponentView.unmountChildComponentView
  // asserts child.superview == self, which fails for reparented children.

  override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    if let container = secureContainer {
      container.insertSubview(childComponentView, at: index)
    } else {
      super.mountChildComponentView(childComponentView, index: index)
    }
  }

  override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    // Just remove from wherever it is — no assertion needed
    childComponentView.removeFromSuperview()
  }

  // MARK: - Paper child management (legacy fallback)

  override func insertReactSubview(_ subview: UIView!, at index: Int) {
    if let container = secureContainer {
      container.insertSubview(subview, at: index)
    } else {
      super.insertReactSubview(subview, at: index)
    }
  }

  override func removeReactSubview(_ subview: UIView!) {
    subview.removeFromSuperview()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    secureContainer?.frame = bounds
  }
}