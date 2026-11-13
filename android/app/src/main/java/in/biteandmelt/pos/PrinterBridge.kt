package `in`.biteandmelt.pos

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Exposed to the web app as window.BiteMeltPrinter.
 * Contract used by public/js/printer.js:
 *   listPrinters()        -> JSON string [{name, address}]  (already-paired devices)
 *   print(address, b64)   -> "OK" or "ERROR: message"
 * Extras used by ui.js / share.js:
 *   saveFile(name, mime, b64)                         -> saves to Downloads
 *   shareFile(name, mime, b64, subject, text)         -> Android share sheet (choose WhatsApp)
 * Methods run on a WebView background thread, so blocking Bluetooth I/O is fine here.
 */
class PrinterBridge(private val activity: Activity) {
    private val sppUuid: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    private fun adapter(): BluetoothAdapter? =
        (activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private fun hasBtPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")
    @JavascriptInterface
    fun listPrinters(): String {
        val out = JSONArray()
        if (!hasBtPermission()) { (activity as MainActivity).askBluetoothPermission(); return out.toString() }
        val bt = adapter() ?: return out.toString()
        if (!bt.isEnabled) return out.toString()
        for (d in bt.bondedDevices.orEmpty()) {
            out.put(JSONObject().put("name", d.name ?: d.address).put("address", d.address))
        }
        return out.toString()
    }

    @SuppressLint("MissingPermission")
    @JavascriptInterface
    @Synchronized
    fun print(address: String, base64: String): String {
        try {
            if (!hasBtPermission()) { (activity as MainActivity).askBluetoothPermission(); return "ERROR: Allow the 'Nearby devices' permission, then print again." }
            val bt = adapter() ?: return "ERROR: This device has no Bluetooth."
            if (!bt.isEnabled) return "ERROR: Bluetooth is off. Turn it on and try again."
            if (!BluetoothAdapter.checkBluetoothAddress(address)) return "ERROR: Printer address is invalid. Re-select the printer in Settings."
            val dev = bt.getRemoteDevice(address)
            if (dev.bondState != android.bluetooth.BluetoothDevice.BOND_BONDED) return "ERROR: Printer is not paired. Pair it in Android Bluetooth settings first."
            val data = Base64.decode(base64, Base64.DEFAULT)
            bt.cancelDiscovery()
            var socket = dev.createRfcommSocketToServiceRecord(sppUuid)
            try {
                socket.connect()
            } catch (e: Exception) {
                try { socket.close() } catch (_: Exception) {}
                // Some cheap printers only connect through the insecure channel
                socket = dev.createInsecureRfcommSocketToServiceRecord(sppUuid)
                socket.connect()
            }
            socket.use { s ->
                val os = s.outputStream
                var i = 0
                while (i < data.size) {                      // small chunks: cheap printers have tiny buffers
                    val n = minOf(512, data.size - i)
                    os.write(data, i, n); os.flush(); i += n
                    Thread.sleep(20)
                }
                Thread.sleep(400)                           // let the printer finish before the socket closes
            }
            return "OK"
        } catch (e: Exception) {
            return "ERROR: Could not print (" + (e.message ?: e.javaClass.simpleName) + "). Check the printer is on, in range and not connected to another phone."
        }
    }

    @JavascriptInterface
    fun changeServer() { (activity as MainActivity).changeServerAddress() }

    private fun writeCache(name: String, base64: String): File {
        val dir = File(activity.cacheDir, "shared").apply { mkdirs() }
        dir.listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > 3600_000) it.delete() }
        val f = File(dir, name.replace(Regex("[^A-Za-z0-9._-]"), "_"))
        f.writeBytes(Base64.decode(base64, Base64.DEFAULT))
        return f
    }

    @JavascriptInterface
    fun saveFile(name: String, mime: String, base64: String): String {
        return try {
            val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val where = FileSaver.saveToDownloads(activity, safe, mime, bytes)
            activity.runOnUiThread { android.widget.Toast.makeText(activity, "Saved to Downloads: $safe", android.widget.Toast.LENGTH_LONG).show() }
            "OK:$where"
        } catch (e: Exception) { "ERROR: " + (e.message ?: "could not save") }
    }

    @JavascriptInterface
    fun shareFile(name: String, mime: String, base64: String, subject: String, text: String): String {
        return try {
            val f = writeCache(name, base64)
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".files", f)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, subject)
                putExtra(Intent.EXTRA_TEXT, text)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.runOnUiThread { activity.startActivity(Intent.createChooser(send, "Share bill")) }
            "OK"
        } catch (e: Exception) { "ERROR: " + (e.message ?: "could not share") }
    }
}
