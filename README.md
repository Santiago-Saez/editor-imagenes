# PixelLab — Editor de imágenes 100% en el navegador

Editor de imágenes estático (HTML + CSS + JS), sin dependencias. Todo el procesamiento es local en tu navegador.

## Requisitos

- Python 3.x instalado (para servir los archivos con `http.server`)
- Un navegador moderno (Chrome / Firefox / Edge)

Comprueba Python con:

```bash
python3 --version
```

## Ejecutar con Python http.server

> Se recomienda servir por HTTP y **no** abrir `index.html` con `file://`, porque los Workers (`worker.js`) fallan en `file://` en algunos navegadores.

1. Abre una terminal en la raíz del proyecto (donde está `index.html`):

```bash
python3 -m http.server 8000
```

2. Abre en tu navegador:

```
http://localhost:8000
```

3. Para detener el servidor, pulsa `Ctrl + C` en la terminal.

### Otras opciones útiles

Cambiar de puerto:

```bash
python3 -m http.server 8080
# -> http://localhost:8080
```

Escuchar en todas las interfaces (para probar desde otro dispositivo en tu red):

```bash
python3 -m http.server 8000 --bind 0.0.0.0
```

Solo Python 2 (no recomendado, solo si no tienes Python 3):

```bash
python -m SimpleHTTPServer 8000
```

## Estructura

```
.
├── index.html
├── styles.css
├── worker.js
└── js/
```

## Uso

1. Pulsa “Abrir imagen” o arrastra una imagen al canvas.
2. Edita en las pestañas: Recorte, Geometría, Ajustes, Capas.
3. Exporta en la pestaña Exportar (PNG / JPEG / WebP).
