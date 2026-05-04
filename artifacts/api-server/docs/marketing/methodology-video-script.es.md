# Video de metodología — Guion + Storyboard

**Publicado:** 2026-05-04
**Formato:** Grabación de pantalla de 90 segundos con narración, incrustada en la página principal sobre el pliegue (debajo del titular, encima de la demo de pegar un informe).
**Audiencia:** Triagers, gerentes de programa e investigadores curiosos que llegan a la página principal y quieren saber — en lenguaje sencillo — qué hace VulnRap antes de confiar en la herramienta.

---

## Objetivos

1. Explicar qué es VulnRap, qué puntúa y por qué importa — en menos de 90 segundos.
2. Mostrar la herramienta funcionando con un informe real pegado. Sin pantallas simuladas.
3. Terminar con una sola llamada a la acción: pega tu propio informe.
4. Mantenerse accesible. Cada sigla (CWE, PoC, AVRI) se deletrea la primera vez que aparece en pantalla _y_ en la narración.

## Objetivo de ritmo

- 90 segundos en total.
- ~135 palabras por minuto en español ≈ ~190 palabras de narración (el español suele ser ~10 % más largo que el inglés; el guion se ha recortado para caber en 95 s).
- 7 bloques. Promedio de 12-14 segundos cada uno.

---

## Guion bloque a bloque

Los tiempos son acumulativos. "NAR" es lo que dice el narrador. "Pantalla" es lo que ve el espectador. "B-roll" es cualquier recurso visual superpuesto.

### Bloque 1 — El problema (0:00 – 0:12)

- **Pantalla:** El explorador de informes (`/reports`) filtrado por envíos recientes. La cámara recorre lentamente una lista de más de 30 títulos. Elegir tres visiblemente de baja calidad: "La página de login está rota", "Bug crítico encontrado", "El sitio es hackeable". (Evitar títulos llenos de siglas como RCE o XSS.)
- **NAR:** "Los triagers de bug bounty abren cientos de informes por semana. Cada vez más están escritos por inteligencia artificial — IA — y son seguros de sí mismos, bien formateados y erróneos. Separar los reales de esa pila es ahora el trabajo."
- **B-roll:** Tres títulos de baja calidad se resaltan brevemente en rojo cuando la narración dice "erróneos."
- **Palabras:** 42.

### Bloque 2 — Presentar VulnRap (0:12 – 0:24)

- **Pantalla:** Corte al héroe de la página principal. Logo, eslogan, caja para pegar.
- **NAR:** "VulnRap es una herramienta gratuita que lee un informe de vulnerabilidad y te dice qué tan probable es que sea trabajo real y reproducible — o basura generada."
- **B-roll:** Tarjeta de texto: _"Basura = informes de bajo esfuerzo o fabricados por IA."_ Permanece 3 segundos.
- **Palabras:** 28.

### Bloque 3 — Pegar un ejemplo (0:24 – 0:36)

- **Pantalla:** El cursor hace clic en la caja. Aparece un informe de ejemplo (usar `/examples/slop-1`). Título, cuerpo y un stack trace fabricado son visibles.
- **NAR:** "Toma este. Cita un CVE — Vulnerabilidades y Exposiciones Comunes — que no existe, apunta a un archivo que no está en el código y su PoC — Prueba de Concepto — nunca funciona."
- **B-roll:** Tres flechas de anotación: "no existe tal CVE", "no existe tal archivo", "la PoC no funciona." La primera flecha también muestra: _"CVE = Vulnerabilidades y Exposiciones Comunes."_ La tercera muestra: _"PoC = Prueba de Concepto."_
- **Palabras:** 34.

### Bloque 4 — Los motores se activan (0:36 – 0:50)

- **Pantalla:** El usuario hace clic en "Puntuar este informe." Un panel lateral se abre mostrando cinco motores que se encienden uno a uno: Lingüístico, Estructural, Reproducibilidad, Referencia cruzada y AVRI (Índice de Razonamiento Adversarial de Vulnerabilidades). Cada uno recibe una marca verde o una X roja.
- **NAR:** "Cinco motores analizan el informe desde distintos ángulos: cómo está escrito, cómo está estructurado, si los pasos funcionan, si las citas existen y si el razonamiento — medido por el AVRI, el Índice de Razonamiento Adversarial de Vulnerabilidades — se sostiene."
- **B-roll:** Al encenderse "AVRI", un texto muestra: _"AVRI = Índice de Razonamiento Adversarial de Vulnerabilidades."_
- **Palabras:** 41.

### Bloque 5 — La puntuación aparece (0:50 – 1:02)

- **Pantalla:** La puntuación final se anima: un número grande ("12 / 100 — Probablemente basura") con un rango de confianza ("±4"). Las cinco subpuntuaciones son visibles debajo, cada una con una razón de una línea.
- **NAR:** "Obtienes una puntuación de cero a cien, un rango de confianza y una razón clara por cada señal que se activó."
- **B-roll:** El cursor pasa sobre una subpuntuación; un tooltip se expande mostrando la cita textual del informe.
- **Palabras:** 21.

### Bloque 6 — Panel de transparencia (1:02 – 1:16)

- **Pantalla:** Corte al panel de transparencia en `/transparency`. Desplazamiento suave mostrando: la gráfica de precisión/exhaustividad por señal, la curva de calibración y el panel de tasa de falsos positivos por CWE (Enumeración de Debilidades Comunes).
- **NAR:** "Cada puntuación es auditable. Publicamos qué tan seguido acierta cada señal, por categoría de CWE — Enumeración de Debilidades Comunes — y con datos públicos. Si no estás de acuerdo, verás por qué."
- **B-roll:** Tarjeta de texto en la primera aparición de CWE: _"CWE = Enumeración de Debilidades Comunes, la lista estándar de categorías de bugs."_
- **Palabras:** 33.

### Bloque 7 — Llamada a la acción (1:16 – 1:30)

- **Pantalla:** Regreso a la caja de pegado en la página principal. El cursor parpadea en el campo vacío. Texto debajo: "Pega cualquier informe. Sin cuenta. Sin datos almacenados."
- **NAR:** "Pega tu propio informe. Sin cuenta, sin datos almacenados. Si nos equivocamos, dinos — cada desacuerdo es un punto de calibración."
- **B-roll:** Tarjeta final: marca VulnRap, URL y la línea _"Gratis. Metodología abierta. Sin login."_
- **Palabras:** 21.

**Total de palabras de narración:** ~208 palabras habladas — a 135 palabras por minuto da ~92 segundos, dentro de la ventana de 95 segundos con un pequeño margen de respiración. No apurar la revelación de la puntuación en el bloque 5; si el ritmo natural del narrador es más lento, el espacio entre bloques absorbe la diferencia.

> Nota sobre el bloque 7: una versión anterior decía "nada sale de tu navegador." Eso exagera el comportamiento actual — la caja de pegado envía el informe a la API de puntuación. La redacción actual ("sin datos almacenados") coincide con el texto en pantalla y la política de privacidad. Verificar ambos antes de grabar.

---

## Lista de tomas (para el grabador)

| #   | Página / URL                | Acción                                                                                | Notas                                                                                                        |
| --- | --------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | `/reports`                  | Desplazamiento lento hacia abajo, ~10 s, sin clics                                    | Filtrar por envíos recientes para que los títulos de baja calidad sean visibles. Capturar a 1920×1080.       |
| 2   | `/` (inicio)                | Héroe estático, 2 s de espera                                                         | Asegurarse de cerrar el banner de cookies antes de grabar.                                                   |
| 3   | `/` (inicio)                | Clic en la caja, pegar el contenido del ejemplo canónico en `/examples/slop-1`        | Usar un grabador que muestre el cursor; no teclear — pegar, para que el tiempo sea predecible.               |
| 4   | `/` (inicio)                | Clic en "Puntuar este informe"                                                       | El panel de motores debe estar expandido. Si un usuario lo colapsó, restablecer el almacenamiento local.     |
| 5   | `/` (inicio)                | Esperar la animación completa de la puntuación, luego pasar el cursor por una subpuntuación | Pasar sobre la fila de "Reproducibilidad" — su tooltip es el más legible.                                   |
| 6   | `/transparency`             | Desplazamiento suave desde arriba hasta el panel de tasa de falsos positivos por CWE   | ~14 s de desplazamiento. Usar un script, no un trackpad, para velocidad consistente.                        |
| 7   | `/` (inicio, arriba)        | Cursor en la caja vacía, parpadeando                                                  | Mantener 4 s para que la tarjeta final se superponga.                                                        |

**Notas de grabación**

- Navegador: Chrome, 1920×1080, zoom al 100 %, sin extensiones visibles.
- Tema: modo claro. (El modo oscuro sirve para una versión B posterior.)
- Velocidad de cuadros: fuente a 60 fps, exportar a 30 fps.
- Silenciar el sistema operativo — capturar la narración por separado y mezclar en postproducción.
- El panel de cinco motores usa animaciones CSS; verificar que se reprodujeron en el archivo capturado antes de continuar.

---

## Archivo de subtítulos (SRT)

Guardar como `methodology-video.es.srt` junto al MP4 eventual. Los tiempos coinciden con la estructura de bloques. Las líneas se mantienen bajo 42 caracteres donde sea posible para que se ajusten bien en móvil.

```srt
1
00:00:00,000 --> 00:00:06,000
Los triagers de bug bounty abren
cientos de informes por semana.

2
00:00:06,000 --> 00:00:12,000
Cada vez más están escritos por IA
(inteligencia artificial) — y son erróneos.

3
00:00:12,000 --> 00:00:18,000
VulnRap es una herramienta gratuita
que lee un informe de vulnerabilidad

4
00:00:18,000 --> 00:00:24,000
y te dice qué tan probable es que sea
trabajo real — o basura generada.

5
00:00:24,000 --> 00:00:30,000
Toma este. Cita un CVE
(Vulnerabilidades y Exposiciones Comunes)

6
00:00:30,000 --> 00:00:36,000
que no existe y su PoC
(Prueba de Concepto) nunca funciona.

7
00:00:36,000 --> 00:00:43,000
Cinco motores analizan el informe
desde distintos ángulos:

8
00:00:43,000 --> 00:00:50,000
cómo está escrito, su estructura,
y el AVRI (Índice de Razonamiento Adversarial).

9
00:00:50,000 --> 00:00:56,000
Obtienes una puntuación de cero
a cien, con un rango de confianza,

10
00:00:56,000 --> 00:01:02,000
y una razón clara por cada
señal que se activó.

11
00:01:02,000 --> 00:01:09,000
Cada puntuación es auditable.
Por categoría de CWE (Enumeración

12
00:01:09,000 --> 00:01:16,000
de Debilidades Comunes) y con datos
públicos. Si no estás de acuerdo, verás por qué.

13
00:01:16,000 --> 00:01:23,000
Pega tu propio informe. Sin cuenta,
sin datos almacenados.

14
00:01:23,000 --> 00:01:30,000
Si nos equivocamos, dinos. Cada
desacuerdo es un punto de calibración.
```

> Nota: Los subtítulos 5-6 abrevian las expansiones de CVE y PoC por límite de caracteres. Las frases completas aparecen en la narración hablada (bloque 3) y como tooltips en el B-roll. El subtítulo 8 menciona AVRI sin expandirlo; la expansión completa ("Índice de Razonamiento Adversarial de Vulnerabilidades") aparece en la narración del bloque 4 y en el B-roll.

---

## Lista de verificación de publicación

Al terminar la grabación y la mezcla, seguir estos pasos en orden:

1. **Archivo maestro**
   - Exportar a 1920×1080, H.264, 30 fps, objetivo ~8 Mbps.
   - Nombre: `methodology-2026-05-es.mp4`.
   - También exportar una versión 720p (`methodology-2026-05-es-720p.mp4`) para conexiones lentas.

2. **Ubicaciones de subida**
   - Primaria: bucket de almacenamiento del proyecto (`marketing/videos/`), servido vía CDN.
   - Espejo: subida no listada a YouTube, para usuarios que prefieran el reproductor o las traducciones automáticas. Enlazar desde el pie de `/transparency`, _no_ desde la página principal.

3. **Ubicación de incrustación**
   - Página principal (`/`), en la misma sección que el video en inglés, como opción de idioma alternativo.
   - Usar etiqueta `<video>` nativa con `preload="metadata"`, `controls` y un póster capturado del bloque 5.
   - Autoplay: **desactivado**.

4. **Subtítulos**
   - Publicar el SRT de arriba como `methodology-video.es.srt` en el mismo bucket.
   - Referenciarlo con `<track kind="captions" srclang="es" label="Español" src="...">`.

5. **Texto alternativo y accesibilidad**
   - `aria-label` en el `<video>`: _"Recorrido de 90 segundos sobre cómo VulnRap puntúa un informe de vulnerabilidad. Subtítulos disponibles."_
   - Debajo del video, un bloque `<details>` titulado "Leer la transcripción" con el texto completo de la narración.

6. **Analítica**
   - Rastrear solo: reproducción iniciada, 25 %, 50 %, 75 %, completada. Sin pings por segundo, sin fingerprinting.

7. **Post-publicación**
   - Actualizar `replit.md` con la ubicación de incrustación.
   - Agregar una fila al registro de pruebas A/B de la página principal indicando la fecha en que el video en español entró en producción.
