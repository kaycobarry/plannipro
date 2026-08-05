export type PlanningShift = {
  id?: string; date: string; start?: string; end?: string; start2?: string; end2?: string;
  label?: string; note?: string; duration_hours?: number;
};

export type PlanningEmployee = {
  employee_id: string; name: string; role?: string; contract_hours?: number;
  planned_hours?: number; delta_hours?: number; shifts?: PlanningShift[];
};

export type PlanningSnapshot = {
  organization_name?: string; establishment_name?: string; week_start: string;
  week_end?: string; publication_version?: number; publication_date?: string; employees: PlanningEmployee[];
};

function latin(value: unknown) {
  return String(value ?? "").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?").replace(/([\\()])/g, "\\$1");
}

function fit(value: unknown, size: number) {
  const text = latin(value);
  return text.length <= size ? text : `${text.slice(0, Math.max(0, size - 3))}...`;
}

function text(value: unknown, x: number, y: number, size = 8, bold = false) {
  return `BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${fit(value, 70)}) Tj ET\n`;
}

function rect(x: number, y: number, w: number, h: number, gray = 1) {
  return `q ${gray} g ${x} ${y} ${w} ${h} re f Q 0.82 G 0.4 w ${x} ${y} ${w} ${h} re S\n`;
}

function formatHours(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)} h` : "0.00 h";
}

function dayDates(weekStart: string) {
  const base = new Date(`${weekStart}T12:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(base); date.setUTCDate(base.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function employeePage(snapshot: PlanningSnapshot, employees: PlanningEmployee[], title: string) {
  const days = dayDates(snapshot.week_start);
  const dayNames = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const pageW = 842, pageH = 595, left = 22, top = 505;
  const employeeW = 145, dayW = 83, totalW = 72, rowH = 46;
  let stream = rect(0, 0, pageW, pageH, 1);
  stream += text("PlanniPro", left, 558, 17, true);
  stream += text(title, left, 538, 11, true);
  stream += text(`${snapshot.establishment_name || "Établissement"} - semaine du ${snapshot.week_start} - version ${snapshot.publication_version || 1}`, left, 523, 8);
  stream += text(`Publié le ${snapshot.publication_date || new Date().toISOString().slice(0, 10)}`, 685, 558, 7);
  let x = left;
  stream += rect(x, top, employeeW, 28, 0.94) + text("Salarie / contrat", x + 6, top + 10, 7, true); x += employeeW;
  days.forEach((date, index) => {
    stream += rect(x, top, dayW, 28, 0.94);
    stream += text(`${dayNames[index]} ${date.slice(8, 10)}/${date.slice(5, 7)}`, x + 5, top + 10, 7, true);
    x += dayW;
  });
  stream += rect(x, top, totalW, 28, 0.94) + text("Total / ecart", x + 5, top + 10, 7, true);

  employees.slice(0, 9).forEach((employee, row) => {
    const y = top - (row + 1) * rowH;
    x = left;
    stream += rect(x, y, employeeW, rowH, 1);
    stream += text(employee.name, x + 6, y + 28, 8, true);
    stream += text(`${employee.role || ""} - contrat ${formatHours(employee.contract_hours)}`, x + 6, y + 13, 6);
    x += employeeW;
    days.forEach((date) => {
      stream += rect(x, y, dayW, rowH, 1);
      const shifts = (employee.shifts || []).filter((shift) => shift.date === date);
      shifts.slice(0, 3).forEach((shift, index) => {
        const schedule = shift.label || [shift.start, shift.end].filter(Boolean).join("-") || shift.note || "";
        stream += text(schedule, x + 4, y + 31 - index * 11, 6, index === 0);
      });
      x += dayW;
    });
    stream += rect(x, y, totalW, rowH, 0.98);
    stream += text(formatHours(employee.planned_hours), x + 5, y + 27, 7, true);
    const delta = Number(employee.delta_hours) || 0;
    stream += text(`${delta >= 0 ? "+" : ""}${delta.toFixed(2)} h`, x + 5, y + 13, 6, Math.abs(delta) > 0.005);
  });
  stream += text("Document confidentiel genere par PlanniPro", left, 25, 6);
  return stream;
}

function encodePdf(streams: string[], title: string) {
  const objects: string[] = [];
  const reserve = () => { objects.push(""); return objects.length; };
  const add = (value: string) => { objects.push(value); return objects.length; };
  const catalog = reserve(), pages = reserve();
  const regular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const refs = streams.map((stream) => {
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    return add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[pages - 1] = `<< /Type /Pages /Kids [${refs.map((ref) => `${ref} 0 R`).join(" ")}] /Count ${refs.length} >>`;
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  add(`<< /Title (${latin(title)}) /Creator (PlanniPro) >>`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets[index + 1] = pdf.length; pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index++) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes = new Uint8Array(pdf.length);
  for (let index = 0; index < pdf.length; index++) bytes[index] = pdf.charCodeAt(index) & 255;
  return bytes;
}

export function buildGlobalPlanningPdf(snapshot: PlanningSnapshot) {
  const chunks: PlanningEmployee[][] = [];
  for (let index = 0; index < snapshot.employees.length; index += 9) chunks.push(snapshot.employees.slice(index, index + 9));
  if (!chunks.length) chunks.push([]);
  return encodePdf(chunks.map((employees) => employeePage(snapshot, employees, "Planning hebdomadaire publie")), "Planning hebdomadaire PlanniPro");
}

export function buildEmployeePlanningPdf(snapshot: PlanningSnapshot, employee: PlanningEmployee) {
  return encodePdf([employeePage(snapshot, [employee], `Planning individuel - ${employee.name}`)], `Planning ${employee.name}`);
}
