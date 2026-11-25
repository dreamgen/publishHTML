import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val syncPureReaderWebAssets by tasks.registering(Sync::class) {
    val webSourceDir = rootProject.projectDir.resolve("../pureReader")
    into(layout.projectDirectory.dir("src/main/assets/www"))
    from(webSourceDir) {
        include("index.html", "extractor.js", "manifest.webmanifest", "icons/**")
    }
}

val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.isFile) {
        keystorePropsFile.inputStream().use { load(it) }
    }
}

val personalStoreFile = (
    keystoreProps.getProperty("storeFile")?.let { file(it) }
        ?: System.getenv("ANDROID_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }?.let { file(it) }
    )?.takeIf { it.isFile }
val personalStorePassword = keystoreProps.getProperty("storePassword")
    ?: System.getenv("ANDROID_STORE_PASSWORD")
val personalKeyAlias = keystoreProps.getProperty("keyAlias")
    ?: System.getenv("ANDROID_KEY_ALIAS")
val personalKeyPassword = keystoreProps.getProperty("keyPassword")
    ?: System.getenv("ANDROID_KEY_PASSWORD")

val hasPersonalSigning =
    personalStoreFile != null &&
        !personalStorePassword.isNullOrBlank() &&
        !personalKeyAlias.isNullOrBlank() &&
        !personalKeyPassword.isNullOrBlank()

val overrideVersionCode = (project.findProperty("purereaderVersionCode") as? String)?.toIntOrNull()
val overrideVersionName = (project.findProperty("purereaderVersionName") as? String)?.takeIf { it.isNotBlank() }

android {
    namespace = "io.github.dreamgen.purereader"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.dreamgen.purereader"
        minSdk = 24
        targetSdk = 35
        versionCode = overrideVersionCode ?: 1
        versionName = overrideVersionName ?: "1.0.0"

        buildConfigField(
            "String",
            "UPDATE_MANIFEST_URL",
            "\"https://github.com/dreamgen/publishHTML/releases/download/purereader-latest/version.json\""
        )
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (hasPersonalSigning) {
            create("personal") {
                storeFile = personalStoreFile
                storePassword = personalStorePassword
                keyAlias = personalKeyAlias
                keyPassword = personalKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            if (hasPersonalSigning) {
                signingConfig = signingConfigs.getByName("personal")
            }
        }
        release {
            isMinifyEnabled = false
            if (hasPersonalSigning) {
                signingConfig = signingConfigs.getByName("personal")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks.named("preBuild") {
    dependsOn(syncPureReaderWebAssets)
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
