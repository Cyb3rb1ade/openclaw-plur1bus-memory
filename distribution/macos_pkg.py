"""Build the native, per-user setup UI and a clearly labelled two-stage PKG."""
from pathlib import Path
import html
import plistlib
import shutil
import subprocess


APP_NAME = "PLUR1BUS einrichten.app"


def build_app(bundle, output, version, sign_identity=None):
    """Embed the verified portable installer behind a SwiftUI profile wizard."""
    app = Path(output) / APP_NAME
    contents = app / "Contents"
    executable = contents / "MacOS/PLUR1BUSSetup"
    executable.parent.mkdir(parents=True)
    resources = contents / "Resources"
    resources.mkdir()
    shutil.copytree(bundle, resources / "distribution")
    source = Path(__file__).parent / "macos/Setup.swift"
    subprocess.run(["xcrun", "swiftc", "-parse-as-library", "-O", "-swift-version", "5",
                    "-target", "arm64-apple-macosx13.0", str(source), "-o", str(executable)], check=True)
    (contents / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleExecutable": "PLUR1BUSSetup", "CFBundleIdentifier": "io.plur1bus.hermes.setup",
        "CFBundleName": "PLUR1BUS einrichten", "CFBundleDisplayName": "PLUR1BUS einrichten",
        "CFBundlePackageType": "APPL", "CFBundleShortVersionString": version.split("-")[0],
        "CFBundleVersion": version.split("-")[0], "PLUR1BUSReleaseVersion": version, "LSMinimumSystemVersion": "13.0",
        "NSHighResolutionCapable": True,
    }))
    # A developer signature/notarization is a separate publication gate. This
    # ad-hoc seal permits local QA and must never be presented as trusted signing.
    command = ["codesign", "--force", "--sign", sign_identity or "-"]
    if sign_identity:
        command += ["--options", "runtime", "--timestamp"]
    subprocess.run(command + [str(app)], check=True)
    return app


def build_pkg(bundle, work, output, version, app_sign_identity=None, installer_sign_identity=None):
    """Stage only the setup app as root; profile changes run later as its user."""
    if bool(app_sign_identity) != bool(installer_sign_identity):
        raise ValueError("both Developer ID Application and Installer identities are required")
    root = Path(work) / "macos-pkg-root"
    root.mkdir()
    app = build_app(bundle, root, version, app_sign_identity)
    component = Path(work) / "setup-component.pkg"
    components = Path(work) / "components.plist"
    components.write_bytes(plistlib.dumps([{"RootRelativeBundlePath": APP_NAME,
                                           "BundleIsRelocatable": False,
                                           "BundleIsVersionChecked": True,
                                           "BundleHasStrictIdentifier": True,
                                           "BundleOverwriteAction": "upgrade"}]))
    subprocess.run(["pkgbuild", "--root", str(root), "--install-location", "/Applications",
                    "--component-plist", str(components),
                    "--identifier", "io.plur1bus.hermes.installer", "--version", version.replace("-hermes", ""),
                    str(component)], check=True)
    resources = Path(work) / "pkg-resources"
    resources.mkdir()
    common = "<html><meta charset='utf-8'><body style='font-family:-apple-system;font-size:14px'>"
    (resources / "welcome.html").write_text(common + """
<h1>PLUR1BUS für Hermes</h1>
<p><b>Schritt 1 von 2:</b> Dieses Paket installiert die App <b>PLUR1BUS einrichten</b> in Programme.</p>
<p><b>Schritt 2:</b> Öffne danach diese App. Dort wählst du grafisch <b>alle vorhandenen Profile</b>,
<b>nur das Standardprofil (default)</b> oder einzelne Profile und bestätigst die Aktivierung.</p>
<p>Hier im Apple-Paketinstaller werden noch keine Hermes-Profile verändert.
Hermes muss bereits eingerichtet sein. Modellgewichte sind nicht enthalten.</p></body></html>
""", encoding="utf-8")
    (resources / "conclusion.html").write_text(common + """
<h1>Jetzt PLUR1BUS einrichten</h1>
<p><b>Der Assistent ist installiert – deine Hermes-Profile noch nicht.</b></p>
<p>Öffne <b>Programme → PLUR1BUS einrichten</b>.</p>
<ol><li>Hermes-Home bestätigen und Profile erkennen lassen.</li>
<li>Alle vorhandenen Profile, nur default oder einzelne Profile auswählen.</li>
<li>Aktivierung eingeschaltet lassen, Plan prüfen, Hermes-Laufzeiten beenden und installieren.</li></ol>
<p>Danach Hermes neu starten. Für später neu angelegte Profile den Assistenten erneut öffnen.
Kein Terminal erforderlich.</p></body></html>
""", encoding="utf-8")
    spec = Path(work) / "Distribution.xml"
    spec.write_text(f"""<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>PLUR1BUS für Hermes – Einrichtungsassistent</title>
  <welcome file="welcome.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <domains enable_localSystem="true" enable_currentUserHome="false" enable_anywhere="false"/>
  <allowed-os-versions><os-version min="13.0"/></allowed-os-versions>
  <choices-outline><line choice="setup"/></choices-outline>
  <choice id="setup" visible="false"><pkg-ref id="io.plur1bus.hermes.installer"/></choice>
  <pkg-ref id="io.plur1bus.hermes.installer" version="{html.escape(version.replace('-hermes', ''), quote=True)}">setup-component.pkg</pkg-ref>
</installer-gui-script>
""", encoding="utf-8")
    command = ["productbuild", "--distribution", str(spec), "--resources", str(resources), "--package-path", str(work)]
    if installer_sign_identity:
        command += ["--sign", installer_sign_identity, "--timestamp"]
    subprocess.run(command + [str(output)], check=True)
    return app
