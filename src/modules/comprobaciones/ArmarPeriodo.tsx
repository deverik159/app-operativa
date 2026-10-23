// ============================================================
// src/modules/comprobaciones/ArmarPeriodo.tsx
// Supervisor · Armar el periodo (fase 2 de Comprobaciones, 23-oct-2026).
//
// POR QUÉ. Erik: «la idea no es que Victor suba el Excel lleno y la app lo
// procese, sino que Victor desde la app construya ese Excel que hoy se usa
// y cuesta tiempo». Aquí entran las campañas del periodo, de cuatro lados
// que acaban en la MISMA carga (comp_cargar_campanas, con previa):
//   · Bitácora comercial (Ecovallas Digital y Biobox): ArmarBitacora.
//   · Pauta VV y el plano (Vía Verde): ArmarPautaVV.
//   · Alta manual: AltaCampanaManual.
//   · Copiar del periodo anterior: AltaCampanaCopiar.
// Y después, el plan de tomas (ArmarPlan) para lo que no lo tenga.
// Es trabajo de computadora (tablas anchas, archivos de 100 MB): en el
// teléfono se ve, con el aviso «Mejor en computadora».
//
// El esqueleto (ComprobacionesView) no desmonta esta pestaña al cambiar de
// periodo o de unidad: por eso todo el estado vive en ArmarInterno, con
// key = unidad + periodo. NO con el id: después de la primera carga el
// periodo recibe su id y lo que se está viendo (el reporte, el plan) debe
// seguir en pantalla.
// ============================================================

import { useCallback, useMemo, useState } from 'react';
import { ETIQUETA_UNIDAD_COMP } from '../../lib/comprobaciones';
import type { PropsArmar } from './tiposComp';
import { diaCorto, etiquetaCampana, fmt, useInventarioComp } from './ArmarComun';
import ArmarBitacora from './ArmarBitacora';
import ArmarPautaVV from './ArmarPautaVV';
import AltaCampanaManual from './AltaCampanaManual';
import AltaCampanaCopiar from './AltaCampanaCopiar';
import { AplicarPlanGrupo, AvisoPlanDeCarga, type GrupoPlan } from './ArmarPlan';

type Fuente = 'bitacora' | 'pauta_vv' | 'manual' | 'copiar';

const ETIQUETA_FUENTE: Record<Fuente, string> = {
  bitacora: 'Bitácora',
  pauta_vv: 'Pauta VV',
  manual: 'Alta manual',
  copiar: 'Copiar anterior',
};

const NOMBRE_FUENTE: Record<string, string> = {
  bitacora: 'bitácora',
  pauta_vv: 'Pauta VV',
  plano: 'plano',
  manual: 'alta manual',
};

export default function ArmarPeriodo(props: PropsArmar) {
  return <ArmarInterno key={`${props.unidad}|${props.periodo.clave}`} {...props} />;
}

function ArmarInterno(props: PropsArmar) {
  const { unidad, periodo, campanas, cargando, telefono, permisos, ocupado } = props;
  const fuentes: Fuente[] = unidad === 'Vía Verde' ? ['pauta_vv', 'bitacora', 'manual', 'copiar'] : ['bitacora', 'manual', 'copiar'];
  const [fuente, setFuente] = useState<Fuente>(fuentes[0]);
  const inventario = useInventarioComp(unidad);
  const [planSinPlan, setPlanSinPlan] = useState<GrupoPlan | null>(null);
  // Cargas terminadas que enseñan su propio plan (ver AvisoPlanDeCarga).
  const [planesDeCarga, setPlanesDeCarga] = useState(0);
  const avisoPlan = useCallback(
    (visible: boolean) => setPlanesDeCarga((n) => Math.max(0, n + (visible ? 1 : -1))),
    []
  );

  const vivas = useMemo(() => campanas.filter((c) => !c.retirada), [campanas]);
  const resumen = useMemo(() => {
    const porFuente = new Map<string, number>();
    for (const c of vivas) porFuente.set(c.fuente, (porFuente.get(c.fuente) ?? 0) + 1);
    return {
      porFuente: [...porFuente.entries()].map(([f, n]) => `${fmt(n)} de ${NOMBRE_FUENTE[f] ?? f}`),
      sitios: vivas.reduce((a, c) => a + c.sitios_activos, 0),
      sinAnalista: vivas.filter((c) => c.estatus === 'abierta' && !c.analista_email).length,
      retiradas: campanas.length - vivas.length,
      sinPlan: vivas.filter((c) => c.estatus === 'abierta' && c.plan_tomas == null),
      tomas: vivas.reduce((a, c) => a + c.tomas_total, 0),
    };
  }, [campanas, vivas]);

  if (!permisos.gestiona)
    return <div className="empty">Solo el Supervisor (o el Admin) arma el periodo de {ETIQUETA_UNIDAD_COMP[unidad]}.</div>;

  return (
    <div>
      {telefono && (
        <div className="banner">
          <b>Mejor en computadora.</b> Armar el periodo lleva archivos pesados y tablas anchas; en el teléfono se puede, pero es
          incómodo.
        </div>
      )}

      <div className="cards" style={{ marginBottom: 14 }}>
        <div className="card">
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{periodo.tipo === 'catorcena' ? 'Catorcena' : 'Mes'}</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{periodo.etiqueta}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {diaCorto(periodo.inicio)} – {diaCorto(periodo.fin)}
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Campañas cargadas</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            {periodo.id == null ? 'Por armar' : cargando && !campanas.length ? '…' : fmt(vivas.length)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
            {periodo.id == null ? 'Aún no hay nada en la base' : resumen.porFuente.join(' · ') || 'ninguna'}
            {resumen.retiradas > 0 ? ` · ${fmt(resumen.retiradas)} retiradas` : ''}
          </div>
        </div>
        {periodo.id != null && (
          <div className="card">
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Sitios · tomas</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              {fmt(resumen.sitios)} · {fmt(resumen.tomas)}
            </div>
            <div style={{ fontSize: 12, color: resumen.sinPlan.length ? 'var(--warn)' : 'var(--muted)' }}>
              {resumen.sinPlan.length ? `${fmt(resumen.sinPlan.length)} sin plan de tomas` : 'Todas con plan'}
              {resumen.sinAnalista ? ` · ${fmt(resumen.sinAnalista)} sin analista` : ''}
            </div>
          </div>
        )}
      </div>

      <div className="toolbar">
        <div className="rt-chips rt-segmento" role="group" aria-label="De dónde salen las campañas">
          {fuentes.map((f) => (
            <button
              key={f}
              type="button"
              className={'rt-chip' + (fuente === f ? ' on' : '')}
              aria-pressed={fuente === f}
              disabled={ocupado != null && fuente !== f}
              onClick={() => setFuente(f)}
            >
              {ETIQUETA_FUENTE[f]}
            </button>
          ))}
        </div>
      </div>

      <AvisoPlanDeCarga.Provider value={avisoPlan}>
      {/* Las cuatro fuentes quedan montadas (ocultas) para no perder lo leído al cambiar de una a otra. */}
      <div hidden={fuente !== 'bitacora'}>
        <ArmarBitacora ctx={props} inventario={inventario} />
      </div>
      {unidad === 'Vía Verde' && (
        <div hidden={fuente !== 'pauta_vv'}>
          <ArmarPautaVV ctx={props} />
        </div>
      )}
      <div hidden={fuente !== 'manual'}>
        <AltaCampanaManual ctx={props} inventario={inventario} />
      </div>
      <div hidden={fuente !== 'copiar'}>
        <AltaCampanaCopiar ctx={props} />
      </div>
      </AvisoPlanDeCarga.Provider>

      {/* Con el plan de una carga recién hecha a la vista, este bloque se
          esconde: eran dos editores para las mismas campañas (23-oct-2026). */}
      {periodo.id != null && !planSinPlan && planesDeCarga > 0 && resumen.sinPlan.length > 0 && (
        <p className="phint" style={{ marginTop: 18 }}>
          El plan de tomas de lo que acabas de cargar está arriba, con la carga. Al terminar, aquí aparecen las que se queden
          sin plan.
        </p>
      )}
      {periodo.id != null && (planSinPlan || (planesDeCarga === 0 && resumen.sinPlan.length > 0)) && (
        <div style={{ marginTop: 26, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
          <h3 style={{ fontSize: 15, margin: '0 0 4px' }}>Plan de tomas del periodo</h3>
          {planSinPlan ? (
            <>
              <AplicarPlanGrupo ctx={props} grupo={planSinPlan} />
              <button type="button" className="btn ghost sm" disabled={ocupado != null} onClick={() => setPlanSinPlan(null)}>
                Cerrar
              </button>
            </>
          ) : (
            <>
              <p className="phint" style={{ marginBottom: 10 }}>
                {fmt(resumen.sinPlan.length)} campaña(s) abiertas todavía no tienen plan: sin plan no hay renglones en el Formato
                general.
              </p>
              <button
                type="button"
                className="btn ghost"
                disabled={ocupado != null}
                onClick={() =>
                  // Foto de la lista al abrir: al aplicar el plan, las campañas
                  // dejan de estar «sin plan» y el resultado debe seguir a la vista.
                  setPlanSinPlan({
                    clave: 'sin-plan',
                    titulo: `${fmt(resumen.sinPlan.length)} campaña(s) sin plan de tomas`,
                    campanas: resumen.sinPlan.map((c) => ({ id: c.id, etiqueta: etiquetaCampana(c) })),
                    planInicial: null,
                  })
                }
              >
                Elegir el plan para las {fmt(resumen.sinPlan.length)}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
