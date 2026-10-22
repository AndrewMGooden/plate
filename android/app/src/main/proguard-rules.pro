# The page talks to Bridge through @JavascriptInterface, which reflection-based
# shrinking cannot see. Kept even though minify is off, so turning it on is safe.
-keepclassmembers class com.plate.tracker.MainActivity$Bridge {
    public *;
}
