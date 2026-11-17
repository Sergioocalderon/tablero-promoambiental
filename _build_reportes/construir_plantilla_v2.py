"""Genera reporte_plantilla_v2.html (plantilla + motor del reporte de fallos de dos secciones)
a partir de un HTML de ejemplo exportado por la aplicación (Paquete_Reporte_de_Fallos).

Uso:  python -X utf8 construir_plantilla_v2.py "<ejemplo.html>"

Qué hace (y por qué):
  - Quita la sección «Evolución de los fallos» (necesita 7 semanas de historial que el add-in no tiene).
  - Conserva las fichas PDF (generador JS incluido); el add-in rellena el bloque data-fault-review.
  - Sustituye TODOS los datos del ejemplo por marcadores {{...}} / bloques JSON vacíos.
  - Falla si queda algún dato del ejemplo dentro de la plantilla.
"""
import json
import re
import sys

MARCAS_DE_EJEMPLO = ['ZIPA', 'PACARIBE', 'PROMO CALI', 'PROMO VALLE', 'SER AMBIENTAL', '03/11/2026', '28 oct', '03 nov',
                     '15:46', 'GVT', 'KENWORTH', 'Últimos 7']


def construir(ruta_ejemplo):
    h = open(ruta_ejemplo, encoding='utf-8').read()

    # 1) Evolución: sección, su script de selector y sus bloques de datos
    h = re.sub(r'<section class="evo-top" id="evo-top".*?</section>', '', h, count=1, flags=re.S)
    h = re.sub(r'<script>\(function\(\)\{var s=document\.getElementById\(\'evo-company\'\).*?</script>', '', h, count=1, flags=re.S)
    h = re.sub(r'<script type="application/json" id="data-evo_\d_\w+">.*?</script>', '', h, flags=re.S)

    # 2) Bloques de datos: el dataset y las dos tablas los entrega el add-in; las tarjetas las repinta el motor
    ids = re.findall(r'<script type="application/json" id="(data-[^"]+)">', h)
    for i in ids:
        if i in ('data-dashboard-dataset', 'data-activos_detalle', 'data-activaciones_detalle'):
            nuevo = '{}'                      # marcador: el add-in lo sustituye (inyectarJson)
        else:
            nuevo = '{"items":[]}' if i != 'data-fault-review' else '{}'
        h = re.sub(r'(<script type="application/json" id="%s">).*?(</script>)' % re.escape(i), lambda m: m.group(1) + nuevo + m.group(2), h, count=1, flags=re.S)

    # 3) Encabezado, impresión y notas
    h = re.sub(r'(<div class="scope">).*?(</div>)', r'\1{{EMPRESA}}\2', h, count=1, flags=re.S)
    h = re.sub(r'(<span class="period-value">).*?(</span>)', r'\1{{PERIODO_VALUE}}\2', h, count=1, flags=re.S)
    h = re.sub(r'(<span class="period-detail">).*?(</span>)', r'\1{{PERIODO_DETAIL}}\2', h, count=1, flags=re.S)
    h = re.sub(r'(<span class="header-value">).*?(</span>)', r'\1{{GENERADO}}\2', h, count=1, flags=re.S)
    h = re.sub(r'(<div class="meta">.*?<div><b>Generado</b>).*?(</div>)', r'\1{{GENERADO}}\2', h, count=1, flags=re.S)
    h = re.sub(r'(<div class="meta">.*?<div><b>Periodo</b>).*?(</div>)', r'\1{{PERIODO_VALUE}} · {{PERIODO_DETAIL}}\2', h, count=1, flags=re.S)
    h = re.sub(r'Corte: [^<]*?\. Incluye todos', 'Corte: {{GENERADO}}. Incluye todos', h, count=1)
    h = re.sub(r'(<p class="scope-note">)[^<]*?(Cuenta los inicios de episodio)', r'\1{{PERIODO_DETAIL}} · {{PERIODO_FECHAS}}. \2', h, count=1)
    h = re.sub(r'(<details class="filters-box"><summary>Filtros aplicados</summary>)<ul>.*?</ul>',
               lambda m: m.group(1) + '<ul>{{FILTROS_LI}}</ul>', h, count=1, flags=re.S)
    # Pie de página: solo lo que el add-in realmente hace (sin base local ni filtros de inclusión)
    h = h.replace('Activos: último estado técnico conocido hasta la generación, incluidos los que comenzaron antes del período.',
                  'Activos: falla cuyo último registro está Active y llegó en las últimas 24 h antes del corte; incluye las que comenzaron antes del período.')
    h = h.replace('Nueva/recurrente: primera activación en el historial local respecto al inicio del período seleccionado.',
                  'Nueva/recurrente: Recurrente si la falla ya estuvo activa en los {{SEMILLA_DIAS}} días previos al período o tuvo más de un episodio; si no, Nueva. '
                  'Una duración con «≥» indica que el inicio real puede ser anterior a esa ventana.')
    h = h.replace('Este reporte no incluye las fallas del equipo telemático ni los indicadores del vehículo ni los fallos de Geotab (GoFault); se pueden incluir con las opciones de los filtros.',
                  'Este reporte no incluye los fallos de Geotab (GoFault): solo camión y OBD.')
    h = re.sub(r'(<span class="kpi-main">)[^<]*(</span>)', r'\1—\2', h)

    # 4) Fichas PDF: se mantienen (el generador es JS dentro de la plantilla; sus datos van en data-fault-review)

    # 5) Verificación: nada del ejemplo puede quedar
    restos = [m for m in MARCAS_DE_EJEMPLO if m in h]
    if restos:
        for m in restos:
            i = h.find(m)
            print('RESTO', repr(m), '->', re.sub(r'\s+', ' ', h[max(0, i - 120):i + 120]))
        raise SystemExit('Quedan datos del ejemplo en la plantilla: %s' % restos)
    return h


if __name__ == '__main__':
    salida = construir(sys.argv[1])
    ruta = __file__.replace('construir_plantilla_v2.py', 'reporte_plantilla_v2.html')
    open(ruta, 'w', encoding='utf-8').write(salida)
    print('Plantilla escrita:', ruta, '-', len(salida) // 1024, 'KB')
    print('Marcadores:', sorted(set(re.findall(r'\{\{\w+\}\}', salida))))
    print('Bloques JSON:', re.findall(r'<script type="application/json" id="([^"]+)">', salida))
