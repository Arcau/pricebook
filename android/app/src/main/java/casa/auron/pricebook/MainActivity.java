package casa.auron.pricebook;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import org.json.JSONObject;

/**
 * A thin shell around the Pricebook web app. The pages come from the server; this adds
 * a native barcode scanner, photo capture for receipts and price tags, and downloads.
 */
public class MainActivity extends Activity {
    private static final int REQUEST_FILE = 1;
    private static final int REQUEST_CAMERA_FOR_PAGE = 2;
    private static final int REQUEST_CAMERA_FOR_PHOTO = 3;

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraPhotoUri;
    private PermissionRequest pendingPagePermission;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);

        webView.addJavascriptInterface(new NativeBridge(), "PricebookNative");
        webView.setWebViewClient(new PageClient());
        webView.setWebChromeClient(new ChromeClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> download(url, userAgent, contentDisposition, mimeType));

        if (savedInstanceState == null) webView.loadUrl(BuildConfig.SERVER_URL);
        else webView.restoreState(savedInstanceState);
    }

    private static boolean isOurServer(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && BuildConfig.SERVER_HOST.equalsIgnoreCase(uri.getHost());
    }

    /** Called from the page: window.PricebookNative.scan(). */
    private final class NativeBridge {
        @JavascriptInterface
        public void scan() {
            runOnUiThread(MainActivity.this::startScan);
        }
    }

    private void startScan() {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E)
                .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(this, options);
        scanner.startScan()
                .addOnSuccessListener(barcode -> callPage("pricebookScanned", barcode.getRawValue()))
                .addOnCanceledListener(() -> callPage("pricebookScanFailed", ""))
                .addOnFailureListener(error -> callPage("pricebookScanFailed",
                        "The scanner could not start. It may still be downloading: check the phone is online and try again in a minute."));
    }

    private void callPage(String function, String argument) {
        String script = "window." + function + " && window." + function + "(" + JSONObject.quote(argument == null ? "" : argument) + ");";
        webView.evaluateJavascript(script, null);
    }

    private final class PageClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (isOurServer(request.getUrl())) return false;
            // Anything that is not the price book opens in the phone's browser instead.
            try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); } catch (Exception ignored) { }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            String page = "<html><head><meta name='viewport' content='width=device-width, initial-scale=1'></head>"
                    + "<body style='font-family:sans-serif;padding:32px 24px;color:#1c2b27'>"
                    + "<h2>Can't reach Pricebook</h2>"
                    + "<p>Check that you are online, then try again.</p>"
                    + "<p><a href='" + BuildConfig.SERVER_URL + "' style='display:inline-block;padding:12px 18px;background:#1f6f5c;color:#fff;border-radius:10px;text-decoration:none'>Try again</a></p>"
                    + "</body></html>";
            view.loadDataWithBaseURL(BuildConfig.SERVER_URL, page, "text/html", "utf-8", BuildConfig.SERVER_URL);
        }
    }

    private final class ChromeClient extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean wantsCamera = false;
            for (String resource : request.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) wantsCamera = true;
            if (!wantsCamera || !isOurServer(request.getOrigin())) { request.deny(); return; }
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
            } else {
                pendingPagePermission = request;
                requestPermissions(new String[] { Manifest.permission.CAMERA }, REQUEST_CAMERA_FOR_PAGE);
            }
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openChooser(true);
            else requestPermissions(new String[] { Manifest.permission.CAMERA }, REQUEST_CAMERA_FOR_PHOTO);
            return true;
        }
    }

    /** Offer "take a photo" alongside "pick an existing picture". */
    private void openChooser(boolean withCamera) {
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*");
        Intent chooser = Intent.createChooser(pick, "Add a photo");
        cameraPhotoUri = null;
        if (withCamera) {
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, "pricebook-" + System.currentTimeMillis() + ".jpg");
                values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Pricebook");
                cameraPhotoUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (cameraPhotoUri != null) {
                    Intent capture = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraPhotoUri);
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { capture });
                }
            } catch (Exception ignored) { cameraPhotoUri = null; }
        }
        try {
            startActivityForResult(chooser, REQUEST_FILE);
        } catch (Exception error) {
            discardCameraPhoto();
            if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
            Toast.makeText(this, "No app available to choose a photo.", Toast.LENGTH_LONG).show();
        }
    }

    private void discardCameraPhoto() {
        if (cameraPhotoUri != null) {
            try { getContentResolver().delete(cameraPhotoUri, null, null); } catch (Exception ignored) { }
            cameraPhotoUri = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (data != null && data.getData() != null) { result = new Uri[] { data.getData() }; discardCameraPhoto(); }
            else if (cameraPhotoUri != null) { result = new Uri[] { cameraPhotoUri }; cameraPhotoUri = null; }
        } else {
            discardCameraPhoto();
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQUEST_CAMERA_FOR_PAGE && pendingPagePermission != null) {
            if (granted) pendingPagePermission.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
            else pendingPagePermission.deny();
            pendingPagePermission = null;
        } else if (requestCode == REQUEST_CAMERA_FOR_PHOTO) {
            // Without the camera permission the person can still pick an existing picture.
            openChooser(granted);
        }
    }

    /** Hand downloads (the CSV export) to the system, carrying the signed-in session. */
    private void download(String url, String userAgent, String contentDisposition, String mimeType) {
        Uri uri = Uri.parse(url);
        if (!isOurServer(uri)) return;
        try {
            DownloadManager.Request request = new DownloadManager.Request(uri);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) request.addRequestHeader("Cookie", cookies);
            request.addRequestHeader("User-Agent", userAgent);
            request.setMimeType(mimeType);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, contentDisposition, mimeType));
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
            Toast.makeText(this, "Downloading to your Downloads folder", Toast.LENGTH_SHORT).show();
        } catch (Exception error) {
            Toast.makeText(this, "The download could not start.", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }
}
