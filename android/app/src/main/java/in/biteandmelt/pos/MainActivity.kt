package `in`.biteandmelt.pos

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.webkit.*
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.net.URI

/**
 * Thin native shell: loads the BITE AND MELT POS server inside a WebView and adds
 *  - window.BiteMeltPrinter (direct Bluetooth ESC/POS printing + file save/share)
 *  - WhatsApp / UPI / tel: links open in their own apps
 *  - download handling for CSV / Excel / database backup
 * The server address is asked once and kept in SharedPreferences; it can be changed later from Settings inside the app.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("pos", MODE_PRIVATE) }
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        val s = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.userAgentString = s.userAgentString + " BiteMeltPOS/1.0"
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.addJavascriptInterface(PrinterBridge(this), "BiteMeltPrinter")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
                val url = req.url
                val server = serverUrl()
                if (server != null && url.host == Uri.parse(server).host && (url.scheme == "http" || url.scheme == "https")) return false
                return try { startActivity(Intent(Intent.ACTION_VIEW, url)); true } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, "No app can open this link", Toast.LENGTH_SHORT).show(); true }
            }
            override fun onReceivedError(v: WebView, req: WebResourceRequest, err: WebResourceError) {
                // The web app has its own offline cache + queue; only show the fallback when even the first page cannot load.
                if (req.isForMainFrame) v.loadData(offlineHtml(), "text/html", "utf-8")
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(w: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null); fileCallback = cb
                return try { startActivityForResult(p.createIntent(), 77); true } catch (e: Exception) { fileCallback = null; false }
            }
        }
        // CSV / XLSX / DB backup links (same-origin, need the login cookie)
        web.setDownloadListener { url, ua, cd, mime, _ ->
            try {
                val name = URLUtil.guessFileName(url, cd, mime)
                val req = android.app.DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    .addRequestHeader("User-Agent", ua)
                    .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name)
                (getSystemService(DOWNLOAD_SERVICE) as android.app.DownloadManager).enqueue(req)
                Toast.makeText(this, "Downloading $name…", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) { Toast.makeText(this, "Download failed: ${e.message}", Toast.LENGTH_LONG).show() }
        }

        if (serverUrl() == null) askServerUrl(first = true) else web.loadUrl(serverUrl()!!)
    }

    private fun serverUrl(): String? = prefs.getString("server", null)

    private fun offlineHtml() = """
        <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#fff">
        <h2 style="color:#1a1a1a">BITE AND MELT POS</h2>
        <p>Cannot reach the POS server.</p><p>Check Wi-Fi / mobile data, then pull back to retry.</p>
        <p style="color:#666;font-size:14px">Server: ${serverUrl()}</p>
        <button style="font-size:20px;padding:14px 28px;background:#FFC928;border:0;border-radius:12px" onclick="location.href='${serverUrl()}'">Retry</button>
        </body></html>""".trimIndent()

    fun changeServerAddress() = runOnUiThread { askServerUrl(false) }

    private fun askServerUrl(first: Boolean) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            hint = "https://pos.yourcafe.in"
            setText(serverUrl() ?: "")
        }
        AlertDialog.Builder(this)
            .setTitle("POS server address")
            .setMessage("Enter the web address where your BITE AND MELT POS server runs (https:// recommended).")
            .setView(input)
            .setCancelable(!first)
            .setPositiveButton("Save") { _, _ ->
                var u = input.text.toString().trim().trimEnd('/')
                if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://$u"
                val ok = try { URI(u).host != null } catch (e: Exception) { false }
                if (!ok) { Toast.makeText(this, "That address is not valid", Toast.LENGTH_LONG).show(); askServerUrl(first); return@setPositiveButton }
                prefs.edit().putString("server", u).apply()
                web.loadUrl(u)
            }
            .apply { if (!first) setNegativeButton("Cancel", null) }
            .show()
    }

    fun askBluetoothPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) runOnUiThread { requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), 5) }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == 77) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data)); fileCallback = null
        } else super.onActivityResult(requestCode, resultCode, data)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else super.onBackPressed() }
}
