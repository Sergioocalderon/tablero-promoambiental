"""
calcular_costo_ralenti.py -- costo en combustible del tiempo en ralentí de la flota
======================================================================================

No consulta Geotab directamente -- toma como INSUMO lo que el equipo ya calculó por
otro lado (horas de ralentí por vehículo, vía la regla de ralentí / el dashboard de
hábitos ya existentes en este proyecto) y el último valor conocido de
DiagnosticInstantaneousFuelRateId, y calcula el consumo en galones para el 100% de
la flota, incluyendo los vehículos que no reportan el diagnóstico.

Cobertura real auditada (2026-09-29): de 80 vehículos activos, 59 tienen lectura
confiable al día, 6 tienen solo datos históricos (mismo tratamiento que los 59 --
"Real (Geotab)" en el reporte, pero con Confiabilidad='Histórico' para que quede
visible que el dato puede estar desactualizado) y 15 no reportan el diagnóstico en
absoluto (Chevrolet NHR, Foton N400, Mercedes Atego 3133) -- para esos 15 se usa una
tasa nominal fija por modelo en vez de asumir consumo cero.

Fórmula de conversión a galones
--------------------------------
CONFIRMADO CONTRA LA CUENTA REAL (2026-09-29, no es una suposición): en esta cuenta
de Geotab, DiagnosticInstantaneousFuelRateId reporta en **m³/s**
(unitOfMeasure='UnitOfMeasureCubicMetersPerSecondId'), NO en L/h -- se verificó tanto
el campo unitOfMeasure del Diagnostic como el orden de magnitud de muestras reales
(valores tipo 1e-6, que como L/h serían consumo casi cero con el motor prendido, pero
como m³/s convierten a un consumo creíble de unos pocos L/h). calcular_ralenti_real_geotab.py
ya hace esta conversión antes de construir cada VehiculoRalenti -- si algún día se
usa este módulo con datos de otra fuente que SÍ venga en L/h, no aplicar la conversión
de abajo dos veces.

    litros_por_hora = metros_cubicos_por_segundo * 1000 * 3600
                     = metros_cubicos_por_segundo * 3_600_000
    (1 m³ = 1000 L; 1 hora = 3600 s, y la tasa hay que "estirarla" de por-segundo a
    por-hora antes de multiplicar por segundos de litros)

Con la tasa ya en L/h:

    consumo_litros = horas_ralenti * tasa_L_h
    consumo_galones = consumo_litros / GALON_US_EN_LITROS   (GALON_US_EN_LITROS = 3.785411784)

NOTA IMPORTANTE, sin confirmar con el usuario: "galón" es ambiguo -- este script usa
el GALÓN ESTADOUNIDENSE (3.785411784 L), el estándar de facto en costeo de flota en
la región, NO el galón imperial (4.546 L, ~20% más grande). Si el reporte que ya
manejan usa el galón imperial, cambiar GALON_US_EN_LITROS por 4.54609 antes de confiar
en los números.

Tasas nominales para vehículos SIN dato real
----------------------------------------------
TASAS_NOMINALES_GAL_H de abajo tiene los 3 modelos sin cobertura con el valor en None
a propósito -- NO se inventó una cifra de galones/hora por modelo porque no hay forma
de verificarla desde este entorno (no es un dato que se pueda derivar de Geotab ni de
este repo). Hay que completarla con una fuente real antes de correr el cálculo para
esos 15 vehículos: ficha técnica del fabricante (consumo en ralentí a RPM de marcha
mínima) o, mejor todavía, el promedio medido en carretera de otro vehículo IDÉNTICO en
motor/año que sí tenga el diagnóstico -- eso da una tasa nominal mucho más confiable
que un dato de catálogo genérico. Hasta que se complete, calcular_consumo_flota()
lanza un error explícito en vez de calcular con un supuesto silencioso.
"""
import argparse
import sys
from dataclasses import dataclass, field
from typing import Optional

import pandas as pd

GALON_US_EN_LITROS = 3.785411784

ORIGEN_REAL = 'Real (Geotab)'
ORIGEN_ESTIMADO = 'Estimado (Tasa Nominal)'

# CAMBIO: valores en None a propósito -- ver docstring del módulo. Completar antes
# de calcular consumo real para estos 3 modelos.
TASAS_NOMINALES_GAL_H = {
    'CHEVROLET NHR': None,
    'FOTON N400': None,
    'MERCEDES ATEGO 3133': None,
}


def metros_cubicos_por_segundo_a_litros_por_hora(valor_m3_s: float) -> float:
    """Convierte una tasa cruda en m3/s (algunos dispositivos GO la reportan así,
    antes de la escala que Geotab aplica normalmente) a L/h."""
    return valor_m3_s * 1000 * 3600


def litros_a_galones(litros: float, galon_en_litros: float = GALON_US_EN_LITROS) -> float:
    return litros / galon_en_litros


@dataclass
class VehiculoRalenti:
    movil: str
    empresa: str
    horas_ralenti: float
    modelo: Optional[str] = None
    # Última tasa instantánea conocida, YA en L/h (ver docstring si el origen
    # trae m3/s -- convertir con metros_cubicos_por_segundo_a_litros_por_hora
    # antes de construir este objeto).
    tasa_l_h: Optional[float] = None
    # 'actual' | 'historico' | None -- para los 6 vehículos con solo datos
    # históricos; no cambia el ORIGEN del dato (sigue siendo "Real (Geotab)"),
    # solo queda visible en la columna Confiabilidad del reporte.
    confiabilidad: Optional[str] = None


ORIGEN_PENDIENTE = 'Pendiente (sin tasa nominal)'


def calcular_consumo_vehiculo(v: VehiculoRalenti, tasas_nominales: dict, estricto: bool = True) -> dict:
    """Calcula UNA fila del reporte final. No decide el promedio de la tasa real
    (eso ya viene resuelto en v.tasa_l_h, calculado por quien construyó el insumo --
    ver nota en calcular_consumo_flota) -- solo aplica la fórmula de conversión y
    decide qué tasa usar según si hay dato real o no.

    `estricto=True` (default) mantiene el comportamiento original: lanza ValueError
    si falta la tasa nominal de un modelo, para nunca reportar un costo inventado.
    `estricto=False` (pedido explícito del usuario -- quiere VER el archivo completo
    para validar la forma del reporte aunque todavía falten tasas nominales por
    confirmar) devuelve la fila igual, con consumo en None y
    Origen='Pendiente (sin tasa nominal)' en vez de detener todo el cálculo -- el
    vehículo queda visible en el reporte, simplemente sin un número inventado."""
    if v.tasa_l_h is not None:
        tasa_l_h = v.tasa_l_h
        origen = ORIGEN_REAL
        confiabilidad = v.confiabilidad or 'actual'
    else:
        modelo_normalizado = (v.modelo or '').strip().upper()
        tasa_gal_h = tasas_nominales.get(modelo_normalizado)
        if tasa_gal_h is None:
            motivo = (
                f"su modelo '{v.modelo}' no está en TASAS_NOMINALES_GAL_H"
                if modelo_normalizado not in tasas_nominales else
                f"el modelo '{modelo_normalizado}' está en TASAS_NOMINALES_GAL_H pero su valor sigue en None"
            )
            if estricto:
                raise ValueError(
                    f"Vehiculo '{v.movil}' no tiene tasa_l_h Y {motivo} -- agregalo antes de calcular "
                    "(ver docstring del módulo). No se asume una cifra por defecto para no reportar un "
                    "costo inventado."
                )
            return {
                'Móvil': v.movil,
                'Empresa': v.empresa,
                'Tiempo total en ralentí (horas)': round(v.horas_ralenti, 2),
                'Consumo total (galones)': None,
                'Origen del Dato': ORIGEN_PENDIENTE,
                'Confiabilidad': f'pendiente -- {motivo}',
            }
        # La tasa nominal ya viene directo en gal/h (así la pide el usuario en el
        # diccionario) -- se pasa a L/h solo para reusar la MISMA fórmula de
        # consumo_litros que la rama real, y mantener una sola fuente de verdad
        # para "horas * tasa -> galones".
        tasa_l_h = tasa_gal_h * GALON_US_EN_LITROS
        origen = ORIGEN_ESTIMADO
        confiabilidad = 'estimado (tasa nominal por modelo)'

    consumo_litros = v.horas_ralenti * tasa_l_h
    consumo_galones = litros_a_galones(consumo_litros)

    return {
        'Móvil': v.movil,
        'Empresa': v.empresa,
        'Tiempo total en ralentí (horas)': round(v.horas_ralenti, 2),
        'Consumo total (galones)': round(consumo_galones, 2),
        'Origen del Dato': origen,
        'Confiabilidad': confiabilidad,
    }


def calcular_consumo_flota(vehiculos: list[VehiculoRalenti], tasas_nominales: dict = None, estricto: bool = True) -> pd.DataFrame:
    """Punto de entrada principal. `vehiculos` ya viene con horas_ralenti calculadas
    por fuera (ej. el dashboard de hábitos / analisis_ralenti.py de este proyecto) --
    este módulo NO recalcula tiempo de ralentí desde StatusData/LogRecord crudo,
    solo convierte ese tiempo en un costo de combustible.

    `estricto=False` deja pasar vehículos sin tasa nominal como filas 'Pendiente' en
    vez de lanzar -- ver calcular_consumo_vehiculo."""
    tasas_nominales = tasas_nominales if tasas_nominales is not None else TASAS_NOMINALES_GAL_H
    filas = [calcular_consumo_vehiculo(v, tasas_nominales, estricto=estricto) for v in vehiculos]
    df = pd.DataFrame(filas)
    # na_position='last': las filas 'Pendiente' (Consumo en None) quedan al final,
    # no intercaladas -- más fácil de revisar de un vistazo qué falta confirmar.
    return df.sort_values('Consumo total (galones)', ascending=False, na_position='last').reset_index(drop=True)


def main():
    parser = argparse.ArgumentParser(description="Calcula el consumo de combustible en ralentí de la flota, en galones.")
    parser.add_argument('--entrada', required=True, help="CSV/Excel con columnas: movil, empresa, horas_ralenti, modelo, tasa_l_h (tasa_l_h vacío para los vehículos sin dato real).")
    parser.add_argument('--salida', default='costo_ralenti.xlsx')
    args = parser.parse_args()

    ruta = args.entrada
    df_entrada = pd.read_excel(ruta) if ruta.lower().endswith(('.xlsx', '.xls')) else pd.read_csv(ruta)

    columnas_requeridas = {'movil', 'empresa', 'horas_ralenti'}
    faltantes = columnas_requeridas - set(df_entrada.columns.str.lower())
    if faltantes:
        print(f"ERROR: faltan columnas en el archivo de entrada: {faltantes}", file=sys.stderr)
        sys.exit(1)

    vehiculos = []
    for _, fila in df_entrada.iterrows():
        tasa = fila.get('tasa_l_h')
        vehiculos.append(VehiculoRalenti(
            movil=str(fila['movil']),
            empresa=str(fila['empresa']),
            horas_ralenti=float(fila['horas_ralenti']),
            modelo=str(fila.get('modelo', '') or ''),
            tasa_l_h=float(tasa) if pd.notna(tasa) else None,
        ))

    try:
        reporte = calcular_consumo_flota(vehiculos)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    reporte.to_excel(args.salida, index=False)
    print(f"Reporte guardado en {args.salida} -- {len(reporte)} vehículo(s).")
    print(reporte.groupby('Origen del Dato')['Consumo total (galones)'].agg(['count', 'sum']))


if __name__ == '__main__':
    main()
