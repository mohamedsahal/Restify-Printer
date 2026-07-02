Direct PDF and PNG printing on Windows uses SumatraPDF (via the pdf-to-printer npm package).

The npm package does not include SumatraPDF.exe. Use one of:

1) Install SumatraPDF from https://www.sumatrapdfreader.org/download-free-pdf-viewer
   (default install path is detected automatically), or

2) Copy SumatraPDF.exe into this folder next to the Restify Printer app:
   vendor\SumatraPDF\SumatraPDF.exe
   Packaged builds: the installer copies this folder under resources\vendor\SumatraPDF\

3) Set environment variable RESTIFY_SUMATRA_PATH to the full path of SumatraPDF.exe

If SumatraPDF is not found, PDF jobs try Adobe Acrobat Reader (AcroRd32.exe /t).
Image jobs fall back to Windows GDI, then Photo Viewer / Paint.
