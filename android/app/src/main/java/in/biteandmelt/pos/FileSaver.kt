package `in`.biteandmelt.pos

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

object FileSaver {
    /** Saves into the public Downloads folder (scoped storage on Android 10+, no permission needed). */
    fun saveToDownloads(ctx: Context, name: String, mime: String, bytes: ByteArray): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("Cannot create file")
            ctx.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
            return uri.toString()
        }
        // Android 8/9: app-specific external folder (no storage permission required)
        val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: ctx.filesDir
        val f = File(dir, name); f.writeBytes(bytes)
        return f.absolutePath
    }
}
