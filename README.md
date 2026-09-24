# Call Center Titania — Módulo de llamadas

Dashboard web conectado a las pestañas `ENTRANTES`, `NPS SALIENTES TOTAL` y `NPS CHAT TOTAL` de Google Sheets. Incluye:

- Total de llamadas y desglose de contestadas, abandonadas y descartadas.
- Nivel de atención y porcentaje de llamadas atendidas en hasta 20 segundos.
- Total, promedio, mínimo y máximo de espera y conversación.
- Tendencias diarias, demanda por hora y día de la semana.
- Ocupación por agente según tiempo efectivo de conversación frente a su jornada disponible.
- En salientes, la ocupación considera el tiempo de todos los intentos, incluso los no contestados, ocupados, congestionados o fallidos.
- Filtros por período, agente, cola/servicio y estado.
- Hallazgos automáticos y detalle de las llamadas más recientes.
- Ranking de los números que más llaman y de los números a los que más se llama.
- Módulo de mensajes con conversaciones entrantes y salientes, estados, grupos, carga por agente, duración total, tiempo del bot y respuesta del agente.
- Módulo NPS consolidado con universo de entrantes, salientes contestadas y chats; encuestas de los tres canales, clientes únicos normalizados, cobertura, tendencias y resultados por agente.

## Ejecutar

Requiere Node.js 18 o superior.

```powershell
npm start
```

Abra `http://localhost:3000`.

## Conectar la pestaña `ENTRANTES`

1. Copie `.env.example` como `.env` si desea cambiar la fuente configurada.
2. Si la hoja está compartida como **Cualquier persona con el enlace**, la configuración predeterminada leerá `ENTRANTES` directamente.
3. Si utiliza **Archivo → Compartir → Publicar en la web**, coloque la URL CSV en `SHEET_CSV_URL`.
4. Reinicie el servidor y pulse **Actualizar**.

Si la hoja no está accesible, el panel muestra datos de demostración y un aviso visible.

## Endpoints

- `GET /api/health` — estado del servidor.
- `GET /api/calls` — filas de la fuente configurada.
- `GET /api/calls?refresh=1` — fuerza una nueva lectura de Google Sheets.
