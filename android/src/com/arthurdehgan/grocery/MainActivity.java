package com.arthurdehgan.grocery;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Hosts the bundled PWA. Assets are served from the APK through a synthetic
 * https://appassets.androidplatform.net origin so the WebView gets a real
 * secure origin: localStorage is reliable and fetch() to api.github.com
 * works (GitHub replies with Access-Control-Allow-Origin: *).
 */
public class MainActivity extends Activity {

    private static final String BASE =
            "https://appassets.androidplatform.net/assets/";
    private static final String HOST = "appassets.androidplatform.net";

    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html");
        MIME.put("htm", "text/html");
        MIME.put("js", "application/javascript");
        MIME.put("mjs", "application/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("txt", "text/plain");
    }

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(250, 250, 247));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        CookieManager.getInstance().setAcceptCookie(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view,
                                                              WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!HOST.equals(uri.getHost())) return null;

                String path = uri.getPath();
                if (path == null) return null;
                if (path.length() > 1 && path.endsWith("/")) {
                    path = path.substring(0, path.length() - 1);
                }
                String asset = path.startsWith("/assets/")
                        ? path.substring("/assets/".length())
                        : path.startsWith("/") ? path.substring(1) : path;
                if (asset.isEmpty()) asset = "index.html";

                InputStream in;
                try {
                    in = getAssets().open(asset);
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8",
                            new java.io.ByteArrayInputStream(new byte[0]));
                }

                int dot = asset.lastIndexOf('.');
                String ext = dot >= 0 ? asset.substring(dot + 1).toLowerCase() : "";
                String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";

                return new WebResourceResponse(mime, "utf-8", in);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view,
                                                    WebResourceRequest request) {
                Uri uri = request.getUrl();
                // Keep the app in the WebView; push everything else to a browser.
                if (HOST.equals(uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient());
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        setContentView(web);

        if (savedInstanceState == null) {
            web.loadUrl(BASE + "index.html");
        } else {
            web.restoreState(savedInstanceState);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        web.saveState(out);
        super.onSaveInstanceState(out);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.clearHistory();
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}