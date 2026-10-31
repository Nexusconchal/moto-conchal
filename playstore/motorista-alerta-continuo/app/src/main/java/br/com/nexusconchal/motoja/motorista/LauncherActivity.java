package br.com.nexusconchal.motoja.motorista;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.window.OnBackInvokedDispatcher;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.File;
import java.util.Collections;

// App em WebView: abre o site do MotoJa dentro do proprio app (sem Chrome por baixo),
// libera GPS, envio de foto, links externos (WhatsApp, mapas, pagamento) e a
// notificacao nativa que o painel do site chama por window.Capacitor.
public class LauncherActivity extends Activity {
    private static final String HOST = "nexusmotoja.com.br";
    private static final int REQ_LOCATION = 10;
    private static final int REQ_NOTIFICATIONS = 11;
    private static final int REQ_FILE = 12;
    private static final int REQ_CAMERA = 13;

    private WebView webView;
    private volatile boolean trustedDriverPage;
    private ImageView splash;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private File cameraFile;
    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;
    private String pendingPermissionCallback;
    private PermissionRequest cameraRequest;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.backgroundColor));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        splash = new ImageView(this);
        splash.setImageResource(R.drawable.splash);
        splash.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        splash.setBackgroundColor(getColor(R.color.backgroundColor));
        root.addView(splash, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        // Android 15+ desenha atras das barras: afasta o site da barra de status e da navegacao.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUserAgentString(s.getUserAgentString() + " NexusMotoJaApp/WebView");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new Bridge(), "NexusNative");
        if (NativePush.available(this)) {
            String shim = capacitorShim();
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(webView, shim,
                        Collections.singleton("https://" + HOST));
            }
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openOutside(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                Uri page = Uri.parse(url);
                trustedDriverPage = "https".equals(page.getScheme()) && HOST.equals(page.getHost()) && "/motoboy.html".equals(page.getPath());
                if (NativePush.available(LauncherActivity.this)
                        && !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    view.evaluateJavascript(capacitorShim(), null);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (splash.getVisibility() == View.VISIBLE) {
                    splash.animate().alpha(0f).setDuration(
                            getResources().getInteger(R.integer.splashScreenFadeOutDuration))
                            .withEndAction(() -> splash.setVisibility(View.GONE));
                }
                CookieManager.getInstance().flush();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                    GeolocationPermissions.Callback callback) {
                if (hasLocation()) {
                    callback.invoke(origin, true, true);
                    return;
                }
                geoOrigin = origin;
                geoCallback = callback;
                requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
            }

            // Camera dentro da tela (getUserMedia): so para o site do MotoJa e so a camera.
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    Uri origem = request.getOrigin();
                    boolean nosso = origem != null && HOST.equals(origem.getHost());
                    boolean soCamera = true;
                    for (String recurso : request.getResources()) {
                        if (!PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(recurso)) soCamera = false;
                    }
                    if (!nosso || !soCamera) {
                        request.deny();
                        return;
                    }
                    if (hasCamera()) {
                        request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                        return;
                    }
                    if (cameraRequest != null) cameraRequest.deny();
                    cameraRequest = request;
                    requestPermissions(new String[] {Manifest.permission.CAMERA}, REQ_CAMERA);
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (cameraRequest == request) cameraRequest = null;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent galeria = params.createIntent();
                Intent camera = acceptsImage(params) && hasCamera() ? cameraIntent() : null;
                // capture="environment" (botao 📷 da nota): abre a camera direto.
                // Sem capture: deixa escolher entre camera e galeria.
                Intent intent = galeria;
                if (camera != null && params.isCaptureEnabled()) {
                    intent = camera;
                } else if (camera != null) {
                    intent = Intent.createChooser(galeria, "Escolha a foto");
                    intent.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] {camera});
                }
                try {
                    startActivityForResult(intent, REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    try {
                        cameraUri = null;
                        startActivityForResult(galeria, REQ_FILE);
                    } catch (ActivityNotFoundException semGaleria) {
                        fileCallback = null;
                        return false;
                    }
                }
                return true;
            }
        });

        registerBack();
        NativePush.attach(this, webView);
        webView.loadUrl(launchUrl(getIntent()));
        NativePush.handleTap(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri data = intent.getData();
        if (data != null && isOurs(data)) webView.loadUrl(data.toString());
        NativePush.handleTap(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        NativePush.detach(webView);
        super.onDestroy();
    }

    private String launchUrl(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data != null && isOurs(data)) return data.toString();
        return getString(R.string.launchUrl);
    }

    private static boolean isOurs(Uri uri) {
        String host = uri.getHost();
        return "https".equals(uri.getScheme()) && host != null
                && (host.equals(HOST) || host.endsWith("." + HOST));
    }

    // Paginas do MotoJa ficam no app; o resto (WhatsApp, mapas, Mercado Pago, telefone) abre fora.
    private boolean openOutside(Uri uri) {
        if (isOurs(uri)) return false;
        String scheme = uri.getScheme();
        if ("about".equals(scheme) || "data".equals(scheme) || "blob".equals(scheme)) return false;
        try {
            Intent intent = "intent".equals(scheme)
                    ? Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
                    : new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (Exception e) {
            String fallback = uri.getQueryParameter("browser_fallback_url");
            if (fallback != null) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(fallback)));
                } catch (Exception ignored) {
                }
            }
        }
        return true;
    }

    private void registerBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        goBack();
    }

    private void goBack() {
        if (webView.canGoBack()) webView.goBack();
        else moveTaskToBack(true);
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_LOCATION && geoCallback != null) {
            geoCallback.invoke(geoOrigin, hasLocation(), true);
            geoCallback = null;
        } else if (requestCode == REQ_CAMERA && cameraRequest != null) {
            if (hasCamera()) cameraRequest.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            else cameraRequest.deny();
            cameraRequest = null;
        } else if (requestCode == REQ_NOTIFICATIONS && pendingPermissionCallback != null) {
            String id = pendingPermissionCallback;
            pendingPermissionCallback = null;
            emit("__permission:" + id, "{\"receive\":\"" + NativePush.permission(this) + "\"}");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            Uri[] escolhidas = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            // A camera grava no arquivo que passamos e nao devolve nada em data.
            if ((escolhidas == null || escolhidas.length == 0) && resultCode == RESULT_OK
                    && cameraUri != null && cameraFile != null && cameraFile.length() > 0) {
                escolhidas = new Uri[] {cameraUri};
            }
            fileCallback.onReceiveValue(escolhidas);
            fileCallback = null;
            cameraUri = null;
            cameraFile = null;
        }
    }

    boolean hasCamera() {
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean acceptsImage(WebChromeClient.FileChooserParams params) {
        String[] tipos = params.getAcceptTypes();
        if (tipos == null || tipos.length == 0) return true;
        for (String tipo : tipos) {
            if (tipo == null || tipo.isEmpty() || tipo.startsWith("image") || tipo.equals("*/*")) return true;
        }
        return false;
    }

    // Foto em tamanho real para a leitura do endereco (a miniatura da camera e pequena demais).
    Intent cameraIntent() {
        try {
            File pasta = new File(getCacheDir(), "fotos");
            if (!pasta.exists() && !pasta.mkdirs()) return null;
            File[] antigas = pasta.listFiles();
            if (antigas != null) for (File antiga : antigas) antiga.delete();
            cameraFile = new File(pasta, "nota-" + System.currentTimeMillis() + ".jpg");
            cameraUri = FileProvider.getUriForFile(this, getString(R.string.providerAuthority), cameraFile);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return intent.resolveActivity(getPackageManager()) != null ? intent : null;
        } catch (RuntimeException e) {
            cameraUri = null;
            cameraFile = null;
            return null;
        }
    }

    void emit(String event, String json) {
        String js = "window.__nexusNativeEmit&&window.__nexusNativeEmit(" + quote(event) + "," + json + ")";
        runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }

    static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    // Mesma interface do plugin PushNotifications do Capacitor, que o motoboy.html ja usa.
    private static String capacitorShim() {
        return "(function(){if(window.Capacitor)return;var L={};"
                + "window.__nexusNativeEmit=function(e,d){(L[e]||[]).slice().forEach(function(f){try{f(d)}catch(x){}})};"
                + "function on(e,f){(L[e]=L[e]||[]).push(f);return{remove:function(){L[e]=(L[e]||[]).filter(function(g){return g!==f})}}}"
                + "var seq=0;var P={"
                + "createChannel:function(){return Promise.resolve()},"
                + "checkPermissions:function(){return Promise.resolve({receive:NexusNative.pushPermission()})},"
                + "requestPermissions:function(){return new Promise(function(r){var id=String(++seq);var h=on('__permission:'+id,function(d){h.remove();r(d)});NexusNative.requestPushPermission(id)})},"
                + "addListener:function(e,f){return Promise.resolve(on(e,f))},"
                + "removeAllListeners:function(){L={};return Promise.resolve()},"
                + "register:function(){NexusNative.registerPush();return Promise.resolve()}};"
                + "window.Capacitor={isNativePlatform:function(){return true},getPlatform:function(){return'android'},Plugins:{PushNotifications:P}};"
                + "})();";
    }

    private class Bridge {
        @JavascriptInterface public int callAlertVersion() { return trustedDriverPage ? 1 : 0; }
        @JavascriptInterface public boolean setCallAlertSession(String json) {
            return trustedDriverPage && CallAlertSession.save(LauncherActivity.this, json);
        }
        @JavascriptInterface public void setCallAlertEnabled(boolean enabled) {
            if (!trustedDriverPage) return;
            CallAlertSession.prefs(LauncherActivity.this).edit().putBoolean("enabled", enabled).apply();
            if (!enabled) CallAlertService.stop(LauncherActivity.this);
        }
        @JavascriptInterface public void setCallAlertOffers(String json) {
            if (trustedDriverPage && json != null && json.length() <= 16000)
                runOnUiThread(() -> CallAlertService.update(LauncherActivity.this, json));
        }
        @JavascriptInterface public void clearCallAlerts() {
            if (!trustedDriverPage) return;
            CallAlertSession.clear(LauncherActivity.this); CallAlertService.stop(LauncherActivity.this);
        }

        @JavascriptInterface
        public String pushPermission() {
            return NativePush.permission(LauncherActivity.this);
        }

        @JavascriptInterface
        public void requestPushPermission(String callbackId) {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                        || "granted".equals(NativePush.permission(LauncherActivity.this))) {
                    emit("__permission:" + callbackId,
                            "{\"receive\":\"" + NativePush.permission(LauncherActivity.this) + "\"}");
                    return;
                }
                pendingPermissionCallback = callbackId;
                requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS},
                        REQ_NOTIFICATIONS);
            });
        }

        @JavascriptInterface
        public void registerPush() {
            NativePush.register(LauncherActivity.this);
        }
    }
}
