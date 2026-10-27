/**
 * OmniSync - Tests para DeltaPatchEngine
 */

import { DeltaPatchEngine } from '../src/sync/delta-patch';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTests() {
  console.log('\n=== Iniciando Suite de Pruebas: DeltaPatchEngine ===\n');

  // Test 1: Archivos idénticos producen parche vacío
  {
    const base = 'Hola mundo\nLínea 2\nLínea 3';
    const patch = DeltaPatchEngine.computePatch(base, base);
    assert(patch === '', 'Archivos idénticos deben retornar parche vacío');
    const applied = DeltaPatchEngine.applyPatch(base, patch);
    assert(applied.success && applied.result === base, 'Aplicar parche vacío retorna texto base intacto');
    console.log('  PASS: Archivos idénticos no generan diff');
  }

  // Test 2: Inserción, reemplazo y eliminación simple
  {
    const base = 'Manzana\nPlátano\nCereza\nDurazno';
    const target = 'Manzana\nPlátano maduro\nFresa\nDurazno';
    const patch = DeltaPatchEngine.computePatch(base, target, 1);

    assert(patch.includes('-Plátano'), 'Debe contener eliminación de Plátano');
    assert(patch.includes('+Plátano maduro'), 'Debe contener inserción de Plátano maduro');
    assert(patch.includes('-Cereza'), 'Debe contener eliminación de Cereza');
    assert(patch.includes('+Fresa'), 'Debe contener inserción de Fresa');

    const applied = DeltaPatchEngine.applyPatch(base, patch);
    assert(applied.success, `Aplicación debe ser exitosa: ${applied.error}`);
    assert(applied.result === target, 'El texto parcheado debe coincidir exactamente con target');
    console.log('  PASS: Inserciones y eliminaciones simples aplicadas fielmente');
  }

  // Test 3: Archivo grande (150 KB / 3.000 líneas), 1 sola línea modificada
  {
    const lines: string[] = [];
    for (let i = 1; i <= 3000; i++) {
      lines.push(`Esta es la línea número ${i} con texto de relleno para simular un documento extenso de notas de investigación.`);
    }
    const baseBig = lines.join('\n');
    assert(baseBig.length > 100000, 'El archivo debe superar 100 KB');

    // Modificamos solo la línea 1420
    const targetLines = [...lines];
    targetLines[1419] = 'Reunión confirmada para el miércoles a las 10:00 con el equipo de ingeniería.';
    const targetBig = targetLines.join('\n');

    const startT = Date.now();
    const patch = DeltaPatchEngine.computePatch(baseBig, targetBig, 2);
    const durationMs = Date.now() - startT;

    assert(patch.length > 0 && patch.length < 1000, `El parche debe ser mínimo (< 1000 bytes), obtenido: ${patch.length} bytes`);
    console.log(`  PASS: Parche de archivo de ${Math.round(baseBig.length / 1024)} KB generado en ${durationMs}ms con peso de solo ${patch.length} bytes`);

    const applyStart = Date.now();
    const applied = DeltaPatchEngine.applyPatch(baseBig, patch);
    const applyDuration = Date.now() - applyStart;

    assert(applied.success, `Aplicación debe ser exitosa: ${applied.error}`);
    assert(applied.result === targetBig, 'El texto resultante debe ser 100% idéntico al target');
    console.log(`  PASS: Parche aplicado en ${applyDuration}ms con reconstrucción exacta bit a bit`);
  }

  // Test 4: Parche aplicado sobre un texto con contexto corrupto debe fallar atómicamente
  {
    const base = 'Línea A\nLínea B\nLínea C';
    const target = 'Línea A\nLínea B modificada\nLínea C';
    const patch = DeltaPatchEngine.computePatch(base, target, 1);

    const corruptBase = 'Línea A\nLínea X (desfasada)\nLínea C';
    const applied = DeltaPatchEngine.applyPatch(corruptBase, patch);

    assert(!applied.success, 'Debe fallar al detectar contexto no coincidente');
    assert(applied.error !== undefined, 'Debe contener un mensaje de error explicativo');
    console.log(`  PASS: Detección defensiva de contexto desfasado previene corrupción: "${applied.error}"`);
  }

  // Test 5: Inserción al inicio y al final
  {
    const base = 'Centro 1\nCentro 2';
    const target = 'Cabecera nueva\nCentro 1\nCentro 2\nPie nuevo';
    const patch = DeltaPatchEngine.computePatch(base, target);
    const applied = DeltaPatchEngine.applyPatch(base, patch);

    assert(applied.success, `Aplicación debe ser exitosa: ${applied.error}`);
    assert(applied.result === target, 'Debe insertar correctamente en los extremos del archivo');
    console.log('  PASS: Inserciones en los extremos aplicadas correctamente');
  }

  // Test 6: El parche no debe partir un surrogate pair (emoji)
  {
    const base = 'hola';
    const target = 'a😀b';
    const patch = DeltaPatchEngine.computePatch(base, target, 1);
    const applied = DeltaPatchEngine.applyPatch(base, patch);

    assert(applied.success, `Aplicación debe ser exitosa: ${applied.error}`);
    assert(
      applied.result === target,
      `Debe preservar el emoji intacto (obtenido: ${JSON.stringify(applied.result)})`
    );
    console.log('  PASS: El parche no parte surrogate pairs (emoji intacto)');
  }

  // Test 7: Un parche con cabeceras de hunk inválidas debe rechazarse
  {
    const malformed = [
      '--- a/f.md',
      '+++ b/f.md',
      '@@ -0,5 +1,1 @@',
      '+inyectado',
      '',
    ].join('\n');
    const applied = DeltaPatchEngine.applyPatch('hola', malformed);
    assert(
      !applied.success,
      'Debe rechazar un hunk con oldStart=0 y oldLines>0 (rango inconsistente)'
    );
    console.log('  PASS: Se rechazan las cabeceras de hunk con rangos inválidos');
  }

  // Test 7b: El rango vacío legítimo (archivo vacío) debe aceptarse
  {
    const emptyRange = ['--- a/f.md', '+++ b/f.md', '@@ -0,0 +1,1 @@', '+contenido', ''].join('\n');
    const applied = DeltaPatchEngine.applyPatch('', emptyRange);
    assert(applied.success, `Debe aceptar el rango vacío convencional: ${applied.error}`);
    assert(applied.result === 'contenido', 'Debe insertar el contenido en un archivo vacío');
    console.log('  PASS: El rango vacío convencional (oldStart=0) se acepta');
  }

  // Test 8: Un hunk con newStart/newLines inconsistentes debe rechazarse
  {
    const malformed = [
      '--- a/f.md',
      '+++ b/f.md',
      '@@ -1,1 +1,99 @@',
      ' hola',
      '+adicional',
      '',
    ].join('\n');
    const applied = DeltaPatchEngine.applyPatch('hola', malformed);
    assert(
      !applied.success,
      'Debe rechazar un hunk cuyo recuento de líneas no cuadra'
    );
    console.log('  PASS: Se rechazan los hunks con recuentos inconsistentes');
  }

  // Test 9: contextLines inválido no debe provocar un bucle infinito
  {
    const base = 'a\nb\nc';
    const target = 'a\nX\nc';
    const patch = DeltaPatchEngine.computePatch(base, target, 0);
    const applied = DeltaPatchEngine.applyPatch(base, patch);
    assert(
      applied.success,
      `Un contextLines de 0 debe seguir produciendo un parche aplicable: ${applied.error}`
    );
    assert(applied.result === target, 'El parche con contextLines=0 debe reconstruir el objetivo');
    console.log('  PASS: contextLines=0 no provoca bucles y produce un parche válido');
  }

  // Test 10: No se deben aceptar parches gigantes
  {
    const huge = 'x'.repeat(5 * 1024 * 1024);
    const applied = DeltaPatchEngine.applyPatch('hola', huge);
    assert(!applied.success, 'Debe rechazar un parche que exceda el límite de tamaño');
    console.log('  PASS: Se rechazan los parches que exceden el límite de tamaño');
  }

  console.log('\n======================================================');
  console.log('🎉 TODAS LAS PRUEBAS DE DELTA PATCH PASARON CON ÉXITO');
  console.log('======================================================\n');
}

runTests().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
