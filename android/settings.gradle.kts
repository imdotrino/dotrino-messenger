pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "messenger"
include(":app")
// La librería nativa del ecosistema (identidad, transporte sellado, contactos, QR, WebRTC,
// barra): el repo dotrino-native, como submódulo en ../native. CONVENCIONES §16.2: nada de eso
// se reimplementa en la app.
includeBuild("../native/android")
