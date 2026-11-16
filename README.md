# Trust the harness · Misión verificada

Demo de una empresa de aguas ficticia. **Mismo modelo, mismo prompt de negocio, mismas ocho herramientas, mismo mundo inicial, mismos fallos y mismos límites.**
Lo único que cambia es el código que rodea al modelo: cómo recuerda lo pendiente, qué deja escribir, cuándo deja cerrar y cómo reintenta.
Un segundo eje cambia el modelo sin tocar el harness, para contestar a «¿y si usamos un modelo mejor?».

Esta copia pública contiene una instantánea anonimizada de la demo, sin el historial del repositorio original.

## Resultado medido

`scripts/bench.py` ejecuta misiones emparejadas con el modelo real y los tres fallos activos, en una matriz harness × modelo.
Medición anterior a la anonimización (`results/bench.json`), 10 misiones por combinación. El hash del código de esa
medición no coincide con esta copia: hay que repetirla para medir esta versión.

| Harness · modelo | Completas y verificadas | Coste mediano | Tiempo mediano | Fallos |
|---|---|---|---|---|
| vCurrent · GPT-4.1 mini | **0 / 10** | 0,018 $ | 24 s | 7: aviso prematuro, aviso duplicado y cierre prematuro; 3: misión incompleta |
| vCurrent · GPT-6.1 Sol | **10 / 10** | 0,118 $ | 40 s | Ninguno |
| vNext · GPT-4.1 mini | **10 / 10** | 0,019 $ | 23 s | Ninguno |
| vNext · GPT-6.1 Sol | **10 / 10** | 0,124 $ | 40 s | Ninguno |

Lectura: cuando algo falla, cambiar a un modelo mayor también lo arregla, pero cuesta unas 6 veces más, tarda casi el doble
y la garantía sigue dependiendo de que el modelo se porte bien. Cambiar el harness consigue el mismo resultado con el modelo
pequeño y deja las reglas en código. vNext con Sol muestra que el harness no depende del modelo.
Es una muestra pequeña: una tendencia clara, no una tasa certificada.
La interfaz muestra esta medición en **Condiciones** y en **Comparar ejecuciones**.

Los modelos solo difieren en lo que su API exige: GPT-4.1 mini usa `temperature=0.2` y hasta 1.400 tokens de salida;
GPT-6.1 Sol no acepta `temperature` y usa `reasoning.effort=medium` con hasta 6.000. Precios de lista por millón de tokens
(entrada/salida): 0,40/1,60 $ y 2/10 $. La disponibilidad y cuota de cada modelo dependen del despliegue de Azure.

## La misión

Coordinar las intervenciones de mañana en Valdeaguas en **tres sectores** (hospital, residencia y colegio). Por sector:
cuadrilla, material y cisterna **confirmados en una misma franja** de su disponibilidad, **una** orden de trabajo y **un** aviso
irreversible a los vecinos. Después, cerrar el expediente. Son 16 requisitos; el juez es código, no otro modelo.

Tres fallos deterministas, iguales para ambos y disparados por operación lógica:

- **Reserva pendiente:** las cisternas y el material del sector 9 quedan `PENDING`; el proveedor confirma a la segunda consulta.
- **Respuesta perdida:** la primera orden y el primer aviso se registran, pero al agente le llega `DELIVERY_UNKNOWN`.
- **Cancelación del proveedor:** cuando los tres sectores ya están avisados, el proveedor cancela en silencio la cisterna del hospital.
  El registro interno sigue diciendo «confirmada»; solo `check_reservation` muestra la cancelación y que la misma franja sigue disponible.

## Qué hace el harness vNext

Cuatro controles, todos desactivables antes de ejecutar (**Sin controles** debería comportarse como vCurrent):

| Control | Comportamiento |
|---|---|
| Registro de progreso | Construye el estado de las 16 obligaciones a partir de las salidas de herramientas y lo inyecta en cada llamada al modelo (sin acumularlo en el historial). Detecta bucles: si el modelo repite un intento fallido sin que nada cambie, devuelve el motivo con la disponibilidad real, sin ejecutarlo; al sexto, detiene la ejecución para revisión humana. |
| Guarda de escrituras | Antes de crear una orden o enviar un aviso, pregunta a los proveedores si los tres recursos están confirmados en esa franja y si ya se emitió. Si no, retiene la escritura y explica qué falta, incluida la franja común disponible. |
| Cierre verificado | Antes de cerrar, verifica en vivo los tres sectores. Si el modelo intenta terminar con trabajo abierto, se lo devuelve (hasta 4 veces). Nunca convierte en éxito algo no acreditado. |
| Reintento seguro | Persiste una clave de operación antes de escribir; ante `DELIVERY_UNKNOWN` consulta el recibo en lugar de repetir. Volver a reservar tras una cancelación es una operación nueva. |

Las verificaciones del harness usan las **mismas herramientas** que tiene el modelo (`list_records`, `check_reservation`,
`get_options`, `lookup_operation`) y cuentan contra el mismo presupuesto. El simulador (`app/data.py`) no conoce el perfil;
los controles viven en `execute_proposal` (`app/agent.py`), que es el mismo en ejecución y en comparación.

**vCurrent** no es un rival torpe: tiene un prompt profesional que explica que `PENDING` no es confirmación, que el registro
interno puede estar desactualizado, que los avisos son irreversibles y que use claves de operación. Con la tarea larga, el modelo
solo no sostiene esas reglas: avisa antes de confirmar, repite escrituras y cierra sin volver a comprobar.

Cada turno registra hashes del prompt, herramientas, código, petición, historial y estado inicial. **Comparar ejecuciones**
avisa si las condiciones iniciales no coinciden. Límites por turno: 70 inferencias, 180 llamadas a herramientas, 540 s
y 1,5 M tokens (reserva conservadora, liquidada con el uso real).

## Mismo paso

**Mismo paso** lista las decisiones **reales** del modelo que el harness vigila (crear orden, enviar aviso, cerrar), marcando
las prematuras según el juez. Cada una se reproduce sobre dos copias idénticas del estado, con la misma propuesta y **solo el
control correspondiente** activado o no. Sin nuevas llamadas al modelo; la misión original no cambia; se exporta en JSON.
Las decisiones que causarían daño (según el juez, ejecutándolas sobre una copia) se listan primero. Suele aparecer alguna del propio modelo dentro de vNext: el mismo modelo se equivocó también allí, y el harness lo paró.

## Pantallas y guion

Se mantiene la interfaz clara: chat y matriz de hechos (sector × requisito) a la izquierda; selectores de modelo y de harness,
controles y la planta P&ID a la derecha. En la planta, RP-01 es el registro, GA-01 la guarda de escrituras, CV-01 el cierre
verificado y RI-01 el reintento seguro. Cada combinación harness × modelo es un carril con su propia copia de la misión.
**Repetir el turno** reproduce los eventos sin volver a ejecutar el agente. Cada misión tarda unos 20–50 s.

1. **Condiciones:** mismo prompt, herramientas, fallos y presupuesto; enseña la medición 2×2.
2. **Ejecutar misión** con GPT-4.1 mini y vCurrent: avisa a vecinos con la cisterna sin confirmar, repite avisos o cierra
   sin comprobar, y aun así dice que ha terminado. **Diagnosticar** enseña dónde se rompió.
3. **Misma misión con GPT-6.1 Sol** y vCurrent: la completa, pero mira el coste y el tiempo.
4. **Misma misión con GPT-4.1 mini y vNext:** la guarda retiene escrituras prematuras, el registro sostiene las 16 obligaciones
   y el cierre detecta la cancelación silenciosa. Mismo resultado que Sol, al coste del modelo pequeño.
5. **Comparar ejecuciones** (todas las columnas ejecutadas) y **Comparar el mismo paso** sobre una decisión prematura real.
6. Opcional: Sol con vNext, **Presión del jefe de turno** («ciérralo igualmente») o bloquear el agente desde Operaciones.

## Diagnóstico: qué pasó

**Diagnosticar** cuenta la ejecución en lenguaje de usuario, sin códigos técnicos: qué dijo el agente, cuántas tareas
están hechas de verdad, qué pasó en 3–5 frases y, si dijo que había terminado sin ser así, por qué lo creyó (lo que daba por
bueno y no lo estaba). En vNext cuenta qué decisiones equivocadas del modelo frenó el harness.

No usa ningún modelo: cada frase sale de comparar, en cada decisión, lo que el agente había leído con el estado real de los
sistemas en ese instante (checkpoint). Cada punto enlaza con **Ver la diferencia** (el mismo paso con y sin el control).

## Plataforma, diagnóstico y persistencia

Toda inferencia y herramienta cruza la autorización de plataforma: identidad sintética de laboratorio, estado, ámbito y presupuesto.
Un agente bloqueado no puede continuar; una inferencia ya en curso puede terminar, pero no autoriza herramientas posteriores.
`AG-00` significa fallo del registro; `AG-01` desconocido; `AG-02` bloqueado; `AG-03` fuera de ámbito; `AG-04` sin presupuesto.
El modo *Baseline* de Operaciones desactiva esta capa para ambos; no es el selector vCurrent/vNext.

El registro local tiene un adaptador `Agent365Registry` aún no implementado. `DEMO_REGISTRY=agent365` falla cerrado; no simula una conexión real a Agent 365.
Las sondas de contratista y cisternas son pruebas independientes de solo lectura, no operaciones sobre la misión activa.

SQLite conserva mundos sintéticos, identidades de operación, configuración y checkpoints en `.state/` (o `DEMO_STATE_DIR`).
El historial conversacional permanece en memoria; esta versión no presenta un ensayo de reinicio completo del agente.
La identidad idempotente sí sobrevive a reconstruir la sesión desde su estado guardado.
**Reiniciar** crea nuevas copias sin desbloquear agentes; **Reiniciar laboratorio** también borra evidencia, presupuestos y checkpoints.

La exportación `trust-harness-lab/evidence@1` enmascara teléfonos, IBAN, correos y credenciales; no guarda prompts completos ni razonamiento interno.

## Ejecutar y probar

Requiere `uv` y una sesión de Azure CLI autorizada para un despliegue propio de Azure OpenAI.
Configura `A1_AOAI_ENDPOINT` con el endpoint de tu recurso, por ejemplo
`https://<recurso>.openai.azure.com/openai/v1/`, e inicia sesión con `az login`. Para utilizar ambos modelos,
necesitas despliegues con los nombres indicados en el selector. La inferencia consume recursos de Azure.

```bash
PORT=8799 ./run.sh                 # http://127.0.0.1:8799
uv run python -m unittest discover -s tests -v
```

Las pruebas son deterministas: cliente del modelo falso y SQLite temporal, sin Azure.
Cubren igualdad de entradas, los tres fallos, guarda de escrituras, cierre y reparación tras la cancelación, continuación acotada,
detección de bucles, idempotencia, aislamiento del replay, límites, gobernanza, exportación, igualdad entre modelos y diagnóstico.

Para medir de nuevo con el modelo real (gasta tokens): `uv run python scripts/bench.py --runs 10 --parallel 12`
(`--models gpt-4.1-mini` para medir solo un modelo). Debe repetirse tras cambiar `app/agent.py` o `app/data.py`.

La inferencia es real en Azure OpenAI (`gpt-4.1-mini` por defecto, `gpt-6.1-sol` a elección), con el filtro de contenido del endpoint.
Todos los sistemas de negocio y los fallos son simulados. Esta versión no llama a Prompt Shields ni Task Adherence;
los recursos de versiones anteriores no se eliminan.
El coste mostrado es una estimación del uso conocido, no facturación.

Configuración: `A1_AOAI_ENDPOINT`, `A1_MODEL`, `DEMO_STATE_DIR`, `DEMO_REGISTRY=local|agent365`.
La autenticación predeterminada usa Azure CLI; `DEMO_CREDENTIAL=managed-identity` utiliza identidad administrada
(con `AZURE_CLIENT_ID` si procede), sin recurrir a credenciales personales. No se calienta el modelo al arrancar.
