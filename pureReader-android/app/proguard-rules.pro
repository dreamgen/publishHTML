-keep class io.github.dreamgen.purereader.PureReaderJsBridge { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
