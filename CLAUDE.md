# Instrucciones para Claude en este proyecto

- Habla con Erik en español, también en las notas cortas de avance.
- El proyecto está dividido en secciones con una ficha cada una en `contexto/`
  (índice en `contexto/README.md`). `contexto/` es un repositorio PRIVADO aparte,
  `deverik159/app-operativa-contexto`; este repo (público) lo ignora.
  - Si `contexto/` no existe en esta computadora, clónalo desde la raíz del proyecto:
    `git clone https://github.com/deverik159/app-operativa-contexto.git contexto`
  - Al empezar: `git -C contexto pull`, y lee `contexto/general.md` y SOLO la ficha de
    la sección en la que vamos a trabajar. Si Erik no la dice, pregúntale.
- Si surge una idea o decisión de otra sección, anótala en esa ficha ("Ideas para
  después" o "Decisiones de Erik", con fecha absoluta y quién la propuso) y sigue.
- Cuando Erik diga "cierra la sección", o antes de cambiar de tema, actualiza la ficha
  de la sección (estado, decisiones con fecha, ideas, pendientes, lecciones) y súbela:
  commit con mensaje en español, `git -C contexto pull --rebase` y `git -C contexto push`.
  Otra conversación u otra computadora puede estar escribiendo: trae antes de subir y
  nunca uses force.
- Nunca escribas en las fichas contraseñas, llaves, tokens, servidores ni correos.
- Las fichas y las notas internas nunca van a este repo, que es público: aquí solo
  viven este archivo y `AGENTS.md`.
