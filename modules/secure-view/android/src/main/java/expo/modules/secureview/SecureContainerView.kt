package expo.modules.secureview

import android.content.Context
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * On Android, FLAG_SECURE is set globally (via expo-screen-capture).
 * This FrameLayout wrapper exists for API consistency with iOS.
 * Children are rendered normally — FLAG_SECURE already prevents screenshots
 * and screen recordings at the window level.
 */
class SecureContainerView(context: Context, appContext: AppContext) : ExpoView(context, appContext)
