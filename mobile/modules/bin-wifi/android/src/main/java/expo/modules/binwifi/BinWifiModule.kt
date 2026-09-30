package expo.modules.binwifi

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.PatternMatcher
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Joins the dustbin's setup hotspot ("Bintelligence-XXXX") from inside the app.
 *
 * The hotspot has no internet, so Android would normally keep sending the
 * app's requests over mobile data. Binding the process to the hotspot network
 * makes fetch("http://192.168.4.1/...") actually reach the bin. Releasing the
 * binding drops the hotspot and returns the phone to its usual network.
 */
class BinWifiModule : Module() {
  private var callback: ConnectivityManager.NetworkCallback? = null

  private val cm: ConnectivityManager
    get() = appContext.reactContext!!.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

  override fun definition() = ModuleDefinition {
    Name("BinWifi")

    Function("isSupported") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
    }

    // Shows Android's "connect to device" sheet listing networks whose name
    // starts with `prefix`. Resolves once joined; rejects if the user cancels
    // or no matching network appears within the timeout.
    AsyncFunction("connectToPrefix") { prefix: String, passphrase: String, promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        promise.reject("UNSUPPORTED", "Joining from the app needs Android 10 or newer.", null)
        return@AsyncFunction
      }
      release()

      val spec = WifiNetworkSpecifier.Builder()
        .setSsidPattern(PatternMatcher(prefix, PatternMatcher.PATTERN_PREFIX))
        .setWpa2Passphrase(passphrase)
        .build()
      val request = NetworkRequest.Builder()
        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
        .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .setNetworkSpecifier(spec)
        .build()

      val settled = AtomicBoolean(false)
      val cb = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          cm.bindProcessToNetwork(network)
          if (settled.compareAndSet(false, true)) promise.resolve(true)
        }

        override fun onUnavailable() {
          callback = null
          if (settled.compareAndSet(false, true)) {
            promise.reject("UNAVAILABLE", "Couldn't join the bin's setup hotspot.", null)
          }
        }
      }
      callback = cb
      cm.requestNetwork(request, cb, CONNECT_TIMEOUT_MS)
    }

    // Manual fallback, after the user joined the hotspot in Android settings:
    // bind to the current WiFi network even though it has no internet.
    Function("bindToCurrentWifi") {
      @Suppress("DEPRECATION")
      val wifi = cm.allNetworks.firstOrNull {
        cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
      }
      if (wifi != null) cm.bindProcessToNetwork(wifi)
      wifi != null
    }

    Function("release") {
      release()
    }

    OnDestroy {
      release()
    }
  }

  private fun release() {
    try {
      cm.bindProcessToNetwork(null)
    } catch (_: Exception) {
    }
    callback?.let {
      try {
        cm.unregisterNetworkCallback(it)
      } catch (_: Exception) {
      }
    }
    callback = null
  }

  companion object {
    private const val CONNECT_TIMEOUT_MS = 120_000
  }
}
