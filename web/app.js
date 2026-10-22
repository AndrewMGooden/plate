/* Plate — standalone build.
   No account, no server. Everything lives in this browser's localStorage.
   Barcode lookups go to Open Food Facts; everything else works offline. */
"use strict";

const MEALS = ["breakfast","lunch","dinner","snack"];
const MEAL_LABEL = {breakfast:"Breakfast",lunch:"Lunch",dinner:"Dinner",snack:"Snacks"};
const MEAL_SHARE = {breakfast:0.25, lunch:0.32, dinner:0.33, snack:0.10};
const OFF_BASE = "https://world.openfoodfacts.org";

const state = {
  profile: {sex:"f",age:30,ht:168,wt:70,act:1.55,goal:"maintain",pace:0.5,goalWt:null,units:"metric"},
  diary: {},
  weights: [],
  foods: []
};
let viewDate = todayKey();
let activeMeal = "breakfast";

/* ============================ dates & helpers ============================ */
function todayKey(){
  const d = new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function shiftKey(key, delta){
  const [y,m,d] = key.split("-").map(Number);
  const dt = new Date(y, m-1, d+delta);
  return dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");
}
function prettyDate(key){
  if(key === todayKey()) return "Today";
  if(key === shiftKey(todayKey(),-1)) return "Yesterday";
  const [y,m,d] = key.split("-").map(Number);
  return new Date(y,m-1,d).toLocaleDateString(undefined,{weekday:"short",day:"numeric",month:"short"});
}
const round = n => Math.round(n);
const r1 = n => Math.round(n*10)/10;
const uid = () => Math.random().toString(36).slice(2,10);
const $ = id => document.getElementById(id);

/* ============================ storage ============================ */
const KEYS = ["profile","diary","weights","foods"];
function lsGet(k){ try{ const v = localStorage.getItem("plate_"+k); return v ? JSON.parse(v) : null; }catch(e){ return null; } }
function save(k){ try{ localStorage.setItem("plate_"+k, JSON.stringify(state[k])); }catch(e){} }

function pruneDiary(){
  const cutoff = shiftKey(todayKey(), -180);
  for(const k of Object.keys(state.diary)) if(k < cutoff) delete state.diary[k];
}
function normalise(){
  state.profile = Object.assign({sex:"f",age:30,ht:168,wt:70,act:1.55,goal:"maintain",pace:0.5,goalWt:null,units:"metric"}, state.profile || {});
  if(!state.diary || typeof state.diary !== "object") state.diary = {};
  if(!Array.isArray(state.weights)) state.weights = [];
  if(!Array.isArray(state.foods)) state.foods = [];
  pruneDiary();
}

/* ============================ the maths ============================ */
function bmr(p){
  const base = 10*p.wt + 6.25*p.ht - 5*p.age;
  return p.sex === "m" ? base + 5 : base - 161;
}
function tdee(p){ return bmr(p) * Number(p.act || 1.2); }
const FLOOR = p => p.sex === "m" ? 1500 : 1200;

function paceOptions(p){
  if(p.goal === "maintain") return [];
  if(p.goal === "lose"){
    const cap = Math.min(1.0, p.wt * 0.0085);
    return [0.25,0.5,0.75,1.0].filter(v => v <= cap + 0.001).map(v => ({v, label: paceLabel(v,"lose")}));
  }
  const cap = Math.min(0.5, p.wt * 0.005);
  return [0.125,0.25,0.5].filter(v => v <= cap + 0.001).map(v => ({v, label: paceLabel(v,"gain")}));
}
function paceLabel(v){
  return (v === 0.125 ? "0.125" : String(v)) + " kg a week — " +
    (v <= 0.25 ? "slow and steady" : v <= 0.5 ? "the usual pace" : v <= 0.75 ? "brisk" : "aggressive");
}

function targets(p){
  const t = tdee(p), floor = FLOOR(p);
  let goalCals = t, note = "", capped = false;

  if(p.goal === "lose"){
    let deficit = Number(p.pace) * 1100;
    const maxDeficit = t * 0.25;
    if(deficit > maxDeficit){ deficit = maxDeficit; capped = true; }
    goalCals = t - deficit;
    if(goalCals < floor){ goalCals = floor; capped = true; }
  } else if(p.goal === "gain"){
    let surplus = Number(p.pace) * 1100;
    const maxSurplus = t * 0.20;
    if(surplus > maxSurplus){ surplus = maxSurplus; capped = true; }
    goalCals = t + surplus;
  }

  const actualRate = (goalCals - t) / 1100;
  if(capped){
    if(p.goal === "lose"){
      note = actualRate > -0.05
        ? "Your maintenance burn is already down at the lowest intake this will plan for, so there's no safe cut left to make. Build the gap with activity instead, or set this up with a dietitian."
        : "Held back to " + Math.abs(r1(actualRate)) + " kg a week — a bigger cut than that costs muscle and rarely sticks.";
    } else {
      note = "Held to " + r1(actualRate) + " kg a week — faster than that is mostly fat, not muscle.";
    }
  }

  /* Protein scales with the weight you're carrying it on, not raw bodyweight:
     past a point, extra fat mass needs no extra protein, and keying off actual
     weight produces targets no real plate can meet. */
  const gPerKg = p.goal === "lose" ? 1.9 : p.goal === "gain" ? 1.7 : 1.5;
  const refWt = Math.min(p.wt, 24.9 * Math.pow(p.ht/100, 2) * 1.15);
  let protein = refWt * gPerKg;
  if(protein * 4 > goalCals * 0.40) protein = goalCals * 0.40 / 4;
  let fat = goalCals * 0.27 / 9;
  const minFat = p.wt * 0.6;
  if(fat < minFat) fat = minFat;
  let carbs = (goalCals - protein*4 - fat*9) / 4;
  if(carbs < 0){ carbs = 0; fat = (goalCals - protein*4) / 9; }

  return {tdee:t, bmr:bmr(p), kcal:goalCals, note, capped, rate:actualRate,
          protein, carbs, fat, fiber: goalCals/1000*14, floor};
}
function bmi(p){ return p.wt / Math.pow(p.ht/100, 2); }
function healthyRange(p){
  const m2 = Math.pow(p.ht/100, 2);
  return [18.5*m2, 24.9*m2];
}

/* ============================ diary ============================ */
function dayOf(key){
  if(!state.diary[key]) state.diary[key] = {breakfast:[],lunch:[],dinner:[],snack:[]};
  const d = state.diary[key];
  for(const m of MEALS) if(!Array.isArray(d[m])) d[m] = [];
  return d;
}
function dayTotals(key){
  const d = state.diary[key];
  const t = {kcal:0,protein:0,carbs:0,fat:0,fiber:0,count:0};
  if(!d) return t;
  for(const m of MEALS) for(const it of (d[m]||[])){
    t.kcal += it.kcal||0; t.protein += it.protein||0; t.carbs += it.carbs||0;
    t.fat += it.fat||0; t.fiber += it.fiber||0; t.count++;
  }
  return t;
}
function loggedDays(n){
  const out = [];
  let k = todayKey();
  for(let i=0;i<n;i++){
    const t = dayTotals(k);
    if(t.count > 0) out.push(Object.assign({key:k}, t));
    k = shiftKey(k,-1);
  }
  return out;
}
function addItem(mealKey, item){
  dayOf(viewDate)[mealKey].push(Object.assign({id:uid(), t:Date.now()}, item));
  save("diary");
  renderToday();
}

/* ============================ coaching ============================ */
function verdictFor(key){
  const T = targets(state.profile);
  const t = dayTotals(key);
  const isToday = key === todayKey();
  const hour = new Date().getHours();
  const remaining = T.kcal - t.kcal;
  const over = -remaining;

  if(t.count === 0){
    return {cls:"v-flat", head: isToday ? "Nothing logged yet" : "Nothing logged that day",
      body:"You have " + round(T.kcal) + " kcal to work with" + (isToday ? " today." : " for that day.")};
  }
  if(over > T.kcal*0.18){
    return {cls:"v-over", head:"Eat less from here",
      body:"You're " + round(over) + " kcal past target. One day doesn't undo anything — eat normally tomorrow rather than skipping meals to make up for it."};
  }
  if(over > 0){
    return {cls:"v-warn", head:"A little over",
      body:round(over) + " kcal past target. Close enough that the week still works out if tomorrow lands on the number."};
  }
  if(isToday && hour < 16 && remaining > T.kcal*0.3){
    return {cls:"v-good", head:"On track",
      body:round(remaining) + " kcal left — that's dinner and a snack still to come."};
  }
  if(remaining > T.kcal*0.30){
    return {cls:"v-warn", head:"Eat more",
      body:"You're " + round(remaining) + " kcal short " + (isToday ? "with the day nearly done" : "that day") +
        ". Eating this far under slows your metabolism and burns muscle — have a proper meal, not a snack."};
  }
  if(remaining > T.kcal*0.10){
    return {cls:"v-good", head:"Room for a bit more",
      body:round(remaining) + " kcal left. A yogurt, a piece of fruit and some nuts would close it."};
  }
  if(remaining >= -1){
    return {cls:"v-good", head:"Right on target",
      body:"You're within " + round(Math.abs(remaining)) + " kcal of the number. Protein is " + round(t.protein) + " g of " + round(T.protein) + " g."};
  }
  return {cls:"v-good", head:"On target", body:"Within range for the day."};
}

/* ============================ rendering ============================ */
function renderAll(){ renderToday(); renderYou(); renderMyFoods(); renderMealSeg(); }

function renderToday(){
  const T = targets(state.profile);
  const t = dayTotals(viewDate);
  $("dayLabel").textContent = prettyDate(viewDate);

  const remaining = T.kcal - t.kcal;
  const pct = Math.max(0, Math.min(1, t.kcal / T.kcal));
  const C = 2 * Math.PI * 56;
  const arc = $("ringArc");
  arc.style.transition = "stroke-dashoffset .4s ease";
  arc.setAttribute("stroke-dashoffset", String(C * (1 - pct)));
  arc.setAttribute("stroke", t.kcal > T.kcal ? "var(--over)" : pct > 0.92 ? "var(--lime)" : "var(--accent)");

  $("ringBig").textContent = remaining >= 0 ? round(remaining) : "+" + round(-remaining);
  $("ringCap").textContent = remaining >= 0 ? "kcal to go" : "kcal over";
  $("kTarget").textContent = round(T.kcal) + " kcal";
  $("kEaten").textContent = round(t.kcal) + " kcal";
  $("kTdee").textContent = round(T.tdee) + " kcal";
  const recent = loggedDays(7);
  $("kAvg").textContent = recent.length ? round(recent.reduce((a,b)=>a+b.kcal,0)/recent.length) + " kcal" : "—";

  const v = verdictFor(viewDate);
  const vEl = $("verdict");
  vEl.className = "verdict " + v.cls;
  vEl.innerHTML = '<div class="vh"></div><div class="vb"></div>';
  vEl.children[0].textContent = v.head;
  vEl.children[1].textContent = v.body;

  const defs = [["Protein",t.protein,T.protein],["Carbs",t.carbs,T.carbs],["Fat",t.fat,T.fat],["Fibre",t.fiber,T.fiber]];
  const mb = $("macroBars");
  mb.innerHTML = "";
  for(const [name, got, goal] of defs){
    const ratio = goal > 0 ? got/goal : 0;
    const row = document.createElement("div");
    row.className = "macro";
    const cls = ratio > 1.12 ? "overfill" : ratio >= 0.92 ? "full" : "";
    row.innerHTML = '<span class="mname"></span><span class="track"><span class="fill ' + cls +
      '" style="width:' + Math.min(100, ratio*100).toFixed(1) + '%"></span></span><span class="mval"></span>';
    row.children[0].textContent = name;
    row.children[2].textContent = round(got) + " / " + round(goal) + " g";
    mb.appendChild(row);
  }

  const d = state.diary[viewDate];
  const list = $("mealList");
  list.innerHTML = "";
  for(const m of MEALS){
    const items = (d && d[m]) ? d[m] : [];
    const sum = items.reduce((a,b)=>a+(b.kcal||0),0);
    const sec = document.createElement("div");
    sec.className = "meal";
    const head = document.createElement("div");
    head.className = "mealhead";
    head.innerHTML = '<span class="mt"></span><span class="mk"></span><button class="addbtn" aria-label="Add to this meal">+</button>';
    head.children[0].textContent = MEAL_LABEL[m];
    head.children[1].textContent = sum ? round(sum) + " kcal" : "";
    head.children[2].addEventListener("click", ()=>{ activeMeal = m; renderMealSeg(); goTab("add"); });
    sec.appendChild(head);

    if(!items.length){
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "Nothing here yet.";
      sec.appendChild(e);
    } else {
      for(const it of items){
        const row = document.createElement("div");
        row.className = "item";
        row.innerHTML = '<span class="iname"><b></b><small></small></span><span class="ik"></span><button class="del" aria-label="Remove">×</button>';
        row.querySelector("b").textContent = it.name;
        row.querySelector("small").textContent = (it.portion ? it.portion + " · " : "") +
          round(it.protein||0) + "p " + round(it.carbs||0) + "c " + round(it.fat||0) + "f";
        row.querySelector(".ik").textContent = round(it.kcal||0);
        row.querySelector(".del").addEventListener("click", ()=>{
          const arr = state.diary[viewDate][m];
          const i = arr.findIndex(x=>x.id===it.id);
          if(i>-1) arr.splice(i,1);
          save("diary"); renderToday();
        });
        sec.appendChild(row);
      }
    }
    list.appendChild(sec);
  }
}

function renderMealSeg(){
  document.querySelectorAll("#mealSeg button").forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.meal === activeMeal)));
}

function renderYou(){
  const p = state.profile, T = targets(p);
  const imperial = p.units === "imperial";
  const conv = v => imperial ? v*2.20462 : v;
  const unit = imperial ? "lb" : "kg";

  $("pSex").value = p.sex;
  $("pAge").value = p.age;
  $("pAct").value = String(p.act);
  $("pGoal").value = p.goal;
  $("metricFields").hidden = imperial;
  $("imperialFields").hidden = !imperial;
  document.querySelectorAll("#unitSeg button").forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.unit === p.units)));
  if(imperial){
    const totalIn = p.ht / 2.54;
    $("pFt").value = Math.floor(totalIn/12);
    $("pIn").value = Math.round(totalIn % 12);
    $("pLb").value = r1(p.wt * 2.20462);
  } else {
    $("pHt").value = r1(p.ht);
    $("pWt").value = r1(p.wt);
  }
  $("wUnit").textContent = unit;
  $("goalWtUnit").textContent = unit;

  const opts = paceOptions(p);
  $("paceWrap").hidden = p.goal === "maintain";
  $("goalWtWrap").hidden = p.goal === "maintain";
  if(opts.length){
    const sel = $("pPace");
    sel.innerHTML = "";
    for(const o of opts){
      const el = document.createElement("option");
      el.value = String(o.v); el.textContent = o.label;
      sel.appendChild(el);
    }
    if(!opts.some(o=>Math.abs(o.v - Number(p.pace)) < 1e-6)) p.pace = opts[Math.min(1,opts.length-1)].v;
    sel.value = String(p.pace);
  }
  $("pGoalWt").value = p.goalWt ? r1(conv(p.goalWt)) : "";

  const [lo,hi] = healthyRange(p);
  const stats = [
    ["Target", round(T.kcal), "kcal/day"],
    ["Maintain at", round(T.tdee), "kcal/day"],
    ["Resting burn", round(T.bmr), "kcal/day"],
    ["Protein", round(T.protein), "g/day"],
    ["BMI", r1(bmi(p)), ""],
    ["Healthy range", r1(conv(lo)) + "–" + r1(conv(hi)), unit]
  ];
  const sr = $("statRow");
  sr.innerHTML = "";
  for(const [label, val, sub] of stats){
    const el = document.createElement("div");
    el.className = "stat";
    el.innerHTML = '<span class="sv"></span><span class="sl"></span>';
    el.children[0].textContent = val;
    el.children[1].textContent = sub ? label + " · " + sub : label;
    sr.appendChild(el);
  }

  const bits = [];
  if(T.note) bits.push(T.note);
  if(p.goal !== "maintain" && p.goalWt && p.goalWt >= lo){
    const diff = p.wt - p.goalWt;
    const weekly = Math.abs(T.rate);
    if(weekly > 0.01 && Math.sign(diff) === (p.goal === "lose" ? 1 : -1)){
      const weeks = Math.abs(diff)/weekly;
      const when = new Date(Date.now() + weeks*7*864e5);
      bits.push("At this pace you'd reach " + r1(conv(p.goalWt)) + " " + unit + " around " +
        when.toLocaleDateString(undefined,{month:"long", year:"numeric"}) + " — about " + Math.round(weeks) + " weeks.");
    }
  }
  if(T.kcal <= T.floor + 1 && p.goal === "lose"){
    bits.push("This is the floor for your profile. Going lower means losing muscle and bone alongside fat.");
  }
  $("targetNote").textContent = bits.join(" ");

  const warn = $("profileWarn");
  warn.innerHTML = "";
  const msgs = [];
  if(p.goalWt && p.goalWt / Math.pow(p.ht/100,2) < 18.5){
    msgs.push("That goal weight is below a healthy BMI for your height. The lowest this will plan toward is " + r1(conv(lo)) + " " + unit + ".");
  }
  if(bmi(p) < 18.5 && p.goal === "lose") msgs.push("You're already below a healthy weight for your height. Losing further isn't something to do without a doctor's input.");
  if(p.age < 18) msgs.push("Calorie formulas like this one are built for adults. Under 18, growth changes the numbers — speak to a doctor before setting a target.");
  for(const m of msgs){
    const el = document.createElement("div");
    el.className = "verdict v-warn";
    el.innerHTML = '<div class="vb"></div>';
    el.children[0].textContent = m;
    warn.appendChild(el);
  }

  renderWeights();
  renderWeek();
}

function renderWeights(){
  const p = state.profile;
  const imperial = p.units === "imperial";
  const conv = v => imperial ? v*2.20462 : v;
  const unit = imperial ? "lb" : "kg";
  const box = $("weightChart");
  const entries = state.weights.slice().sort((a,b)=> a.d < b.d ? -1 : 1);
  box.innerHTML = "";

  if(entries.length < 2){
    box.innerHTML = '<p class="hint">Log your weight twice a week, same time of day. Two readings and a trend line shows up here.</p>';
    $("trendNote").textContent = "";
    return;
  }

  const W = 320, H = 120, padL = 34, padR = 8, padT = 12, padB = 20;
  const vals = entries.map(e => conv(e.kg));
  const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  const span = Math.max(0.8, max - min);
  const lo = min - span*0.18, hi = max + span*0.18;
  const x = i => padL + (W - padL - padR) * (entries.length === 1 ? 0.5 : i/(entries.length-1));
  const y = v => padT + (H - padT - padB) * (1 - (v - lo)/(hi - lo));
  const pts = vals.map((v,i)=> x(i).toFixed(1)+","+y(v).toFixed(1)).join(" ");
  const area = "M" + x(0).toFixed(1) + "," + (H-padB) + " L " + pts.split(" ").join(" L ") + " L " + x(vals.length-1).toFixed(1) + "," + (H-padB) + " Z";

  let svg = '<svg class="spark" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Weight over time">';
  for(const tk of [hi - (hi-lo)*0.15, lo + (hi-lo)*0.15]){
    svg += '<line x1="'+padL+'" y1="'+y(tk).toFixed(1)+'" x2="'+(W-padR)+'" y2="'+y(tk).toFixed(1)+'" stroke="var(--line)" stroke-width="1"/>';
    svg += '<text x="4" y="'+(y(tk)+3.5).toFixed(1)+'" font-size="9" font-family="IBM Plex Mono, monospace" fill="var(--muted)">'+r1(tk)+'</text>';
  }
  svg += '<path d="'+area+'" fill="var(--accent-soft)" stroke="none"/>';
  svg += '<polyline points="'+pts+'" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  svg += '<circle cx="'+x(vals.length-1).toFixed(1)+'" cy="'+y(vals[vals.length-1]).toFixed(1)+'" r="4" fill="var(--accent)"/>';
  svg += '<text x="'+padL+'" y="'+(H-5)+'" font-size="9" font-family="IBM Plex Mono, monospace" fill="var(--muted)">'+entries[0].d.slice(5)+'</text>';
  svg += '<text x="'+(W-padR)+'" y="'+(H-5)+'" text-anchor="end" font-size="9" font-family="IBM Plex Mono, monospace" fill="var(--muted)">'+entries[entries.length-1].d.slice(5)+'</text>';
  svg += '</svg>';
  box.innerHTML = svg;

  const last = entries[entries.length-1], first = entries[0];
  const days = Math.max(1, (new Date(last.d) - new Date(first.d)) / 864e5);
  const perWeek = (last.kg - first.kg) / days * 7;
  const T = targets(p);
  const dir = perWeek < -0.05 ? "down" : perWeek > 0.05 ? "up" : "flat";
  let msg = dir === "flat"
    ? "Holding steady over " + Math.round(days) + " days."
    : (dir === "down" ? "Down " : "Up ") + r1(Math.abs(conv(perWeek))) + " " + unit + " a week over " + Math.round(days) + " days.";
  if(p.goal !== "maintain" && dir !== "flat"){
    const want = T.rate, got = perWeek;
    if(Math.sign(want) !== Math.sign(got)){
      msg += p.goal === "lose"
        ? " That's the wrong direction — the likeliest cause is portions being bigger than logged. Weigh a few things for a week."
        : " That's the wrong direction — add a third meal or a shake rather than bigger dinners.";
    } else if(Math.abs(got) < Math.abs(want)*0.5){
      msg += " Slower than the " + r1(Math.abs(conv(want))) + " " + unit + " a week you're aiming for. Give it another fortnight before changing anything.";
    } else if(Math.abs(got) > Math.abs(want)*1.8){
      msg += p.goal === "lose"
        ? " Faster than planned. Eat 150–200 kcal more a day — losing this quickly costs muscle."
        : " Faster than planned, which means more of it is fat. Ease the surplus back.";
    } else {
      msg += " That's right on plan.";
    }
  }
  $("trendNote").textContent = msg;
}

function renderWeek(){
  const T = targets(state.profile);
  const days = loggedDays(7);
  const box = $("weekReview");
  if(!days.length){
    box.innerHTML = '<p class="hint">Log a few days and a weekly read-out appears here — average intake, protein, and whether to eat more or less.</p>';
    return;
  }
  const avg = days.reduce((a,b)=>a+b.kcal,0)/days.length;
  const avgP = days.reduce((a,b)=>a+b.protein,0)/days.length;
  const gap = avg - T.kcal;

  let head, cls, body;
  if(Math.abs(gap) <= T.kcal*0.07){
    head = "Holding the line"; cls = "v-good";
    body = "You averaged " + round(avg) + " kcal across " + days.length + " logged day" + (days.length>1?"s":"") +
      ", against a " + round(T.kcal) + " target. Keep doing this.";
  } else if(gap > 0){
    head = "Eat less"; cls = "v-warn";
    body = "You averaged " + round(gap) + " kcal a day over target. That's roughly " + r1(gap*7/7700) +
      " kg a week in the wrong direction. The usual fix is one specific thing — the drink, the late snack, the oil in the pan.";
  } else {
    head = "Eat more"; cls = Math.abs(gap) > T.kcal*0.22 ? "v-over" : "v-warn";
    body = "You averaged " + round(-gap) + " kcal a day under target. Under-eating this much makes you tired, hungry and more likely to give up. Add a real meal, not a snack.";
  }
  const extra = avgP < T.protein*0.8
    ? " Protein averaged " + round(avgP) + " g against a " + round(T.protein) + " g target — that's the gap to close first, whatever the calories do."
    : "";

  box.innerHTML = '<div class="verdict ' + cls + '"><div class="vh"></div><div class="vb"></div></div>' +
    '<div style="display:flex;gap:6px;margin-top:10px;align-items:flex-end;height:54px">' +
    days.slice().reverse().map(d=>{
      const h = Math.max(4, Math.min(54, d.kcal / Math.max(T.kcal*1.4, 1) * 54));
      const col = d.kcal > T.kcal*1.07 ? "var(--over)" : d.kcal < T.kcal*0.85 ? "var(--warn)" : "var(--accent)";
      return '<div style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:4px">' +
        '<div style="width:100%;height:'+h.toFixed(0)+'px;background:'+col+';border-radius:4px 4px 0 0"></div>' +
        '<span style="font-size:9px;color:var(--muted);font-family:var(--data)">'+d.key.slice(8)+'</span></div>';
    }).join("") + '</div>';
  const v = box.querySelector(".verdict");
  v.children[0].textContent = head;
  v.children[1].textContent = body + extra;
}

function renderMyFoods(){
  const box = $("myFoods");
  if(!state.foods.length){
    box.innerHTML = '<p class="hint">Foods you enter by hand, and products you scan, are saved here so you only look them up once.</p>';
    return;
  }
  box.innerHTML = "";
  const list = document.createElement("div");
  list.className = "result";
  for(const f of state.foods){
    const row = document.createElement("div");
    row.className = "rrow";
    row.innerHTML = '<span class="rn"><b></b><small></small></span><span class="rk"></span>' +
      '<button class="del" style="background:none;border:0;color:var(--muted);font-size:15px" aria-label="Remove">×</button>';
    row.querySelector("b").textContent = f.name;
    row.querySelector("small").textContent = f.plabel || f.portionLabel || "1 serving";
    row.querySelector(".rk").textContent = round(f.kcal * (f.portion||100)/100) + " kcal";
    row.querySelector(".del").addEventListener("click", ()=>{
      state.foods = state.foods.filter(x=>x.id !== f.id);
      save("foods"); renderMyFoods();
    });
    list.appendChild(row);
  }
  box.appendChild(list);
}

/* ============================ search ============================ */
function searchLocal(q){
  const term = q.trim().toLowerCase();
  if(term.length < 2) return [];
  const pool = state.foods.concat(FOODS);
  const scored = [];
  for(const f of pool){
    const n = f.name.toLowerCase();
    let s = -1;
    if(n.startsWith(term)) s = 0;
    else if(n.includes(term)) s = 1;
    else if((f.cat||"").toLowerCase().includes(term)) s = 2;
    if(s >= 0) scored.push([s, f]);
  }
  scored.sort((a,b)=> a[0]-b[0] || a[1].name.length - b[1].name.length);
  return scored.slice(0,20).map(x=>x[1]);
}

function listEl(items, label){
  const frag = document.createDocumentFragment();
  if(label){
    const h = document.createElement("div");
    h.className = "eyebrow";
    h.style.margin = "12px 0 6px";
    h.textContent = label;
    frag.appendChild(h);
  }
  const list = document.createElement("div");
  list.className = "searchlist";
  for(const f of items){
    const b = document.createElement("button");
    b.innerHTML = '<span class="sn"></span><span class="sk"></span>';
    b.children[0].textContent = f.name + (f.brand ? " · " + f.brand : "");
    b.children[1].textContent = round(f.kcal * (f.portion||100)/100) + " kcal";
    b.addEventListener("click", ()=> showPortion(f, "portionBox"));
    list.appendChild(b);
  }
  frag.appendChild(list);
  return frag;
}

let searchTimer = null;
function renderSearch(q){
  const box = $("searchResults");
  box.innerHTML = "";
  $("portionBox").innerHTML = "";
  clearTimeout(searchTimer);
  if(!q.trim()) return;

  const res = searchLocal(q);
  if(res.length) box.appendChild(listEl(res, "Food list"));
  else box.innerHTML = '<p class="hint">Not in the built-in list.</p>';

  if(q.trim().length >= 3 && navigator.onLine){
    const pending = document.createElement("p");
    pending.className = "hint";
    pending.style.marginTop = "10px";
    pending.textContent = "Searching branded products…";
    box.appendChild(pending);
    searchTimer = setTimeout(async ()=>{
      try{
        const hits = await offSearch(q.trim());
        pending.remove();
        if(hits.length) box.appendChild(listEl(hits, "Branded products · Open Food Facts"));
      }catch(e){
        pending.className = "hint";
        pending.textContent = "Couldn't reach Open Food Facts just now.";
      }
    }, 500);
  }
}

function showPortion(f, boxId){
  const box = $(boxId);
  box.innerHTML = "";
  const card = document.createElement("div");
  card.className = "card";
  card.style.background = "var(--surface-2)";
  card.innerHTML =
    '<div class="eyebrow"></div><h2 style="margin:4px 0 10px"></h2>' +
    '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">' +
    '<label class="fld" style="flex:1;min-width:84px">Amount<input type="number" class="pg" step="5" min="1" inputmode="decimal"></label>' +
    '<label class="fld" style="flex:0 0 76px">Unit<select class="pu"><option value="g">g</option><option value="serv">serving</option></select></label>' +
    '<button class="btn pAdd" style="height:38px">Add</button></div>' +
    '<p class="hint pSummary" style="margin-top:10px"></p>';
  card.querySelector(".eyebrow").textContent = (f.brand ? f.brand + " · " : "") + (f.cat || "Food");
  card.querySelector("h2").textContent = f.name;
  box.appendChild(card);

  const gi = card.querySelector(".pg"), ui = card.querySelector(".pu"), sum = card.querySelector(".pSummary");
  const portion = f.portion || 100;

  /* Hand-entered foods carry one serving's numbers, so they're counted in servings, not grams. */
  if(f.servingMode){
    ui.parentElement.hidden = true;
    gi.step = "0.25"; gi.min = "0.25"; gi.value = "1";
    gi.parentElement.firstChild.textContent = "Servings";
  } else {
    gi.value = portion;
  }
  const grams = ()=> f.servingMode
    ? (Number(gi.value)||1) * 100
    : (ui.value === "serv" ? (Number(gi.value)||1) * portion : (Number(gi.value)||0));

  const upd = ()=>{
    const g = grams(), k = g/100;
    sum.textContent = (f.servingMode ? "One serving is " + (f.plabel || "as entered") : "Default portion is " + (f.plabel || (portion + " g"))) +
      ". This is " + round(f.kcal*k) + " kcal · " + r1(f.p*k) + " g protein · " + r1(f.c*k) + " g carbs · " + r1(f.f*k) + " g fat";
  };
  gi.addEventListener("input", upd);
  ui.addEventListener("change", ()=>{ gi.value = ui.value === "serv" ? 1 : portion; upd(); });
  upd();

  card.querySelector(".pAdd").addEventListener("click", ()=>{
    const g = grams(); if(!(g>0)) return;
    const k = g/100;
    const label = f.servingMode ? (r1(g/100) + " × " + (f.plabel || "serving")) : (round(g) + " g");
    addItem(activeMeal, {name: f.name + (f.brand ? " (" + f.brand + ")" : ""), portion: label,
      kcal:f.kcal*k, protein:f.p*k, carbs:f.c*k, fat:f.f*k, fiber:(f.fib||0)*k, src: f.off ? "off" : "list"});
    if(f.off && !state.foods.some(x=>x.code && x.code === f.code)){
      state.foods.push(Object.assign({id:uid()}, f));
      save("foods"); renderMyFoods();
    }
    box.innerHTML = "";
    $("foodSearch").value = "";
    $("searchResults").innerHTML = "";
    flash("Added to " + MEAL_LABEL[activeMeal].toLowerCase());
  });
}

/* ============================ Open Food Facts ============================ */
function num(v){ const n = Number(v); return isFinite(n) && n >= 0 ? n : 0; }

function offNormalise(prod){
  const n = prod.nutriments || {};
  let kcal = num(n["energy-kcal_100g"]);
  if(!kcal && n["energy_100g"]) kcal = num(n["energy_100g"]) / 4.184;
  const name = (prod.product_name || prod.product_name_en || "").trim();
  if(!name || !kcal) return null;

  let portion = 100, plabel = "100 g";
  const ss = String(prod.serving_size || "").trim();
  const m = ss.match(/([\d.]+)\s*(g|ml)/i);
  if(m){
    const g = Number(m[1]);
    if(g > 0 && g < 1500){ portion = g; plabel = ss; }
  }
  return {
    name, brand: (prod.brands || "").split(",")[0].trim(), cat: "Branded",
    kcal, p: num(n["proteins_100g"]), c: num(n["carbohydrates_100g"]),
    f: num(n["fat_100g"]), fib: num(n["fiber_100g"]),
    portion, plabel, code: String(prod.code || ""), off: true
  };
}

async function offProduct(code){
  const url = OFF_BASE + "/api/v2/product/" + encodeURIComponent(code) +
    ".json?fields=code,product_name,product_name_en,brands,serving_size,nutriments";
  const r = await fetch(url, {headers:{Accept:"application/json"}});
  if(!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  if(!j || j.status !== 1 || !j.product) return null;
  return offNormalise(j.product);
}

async function offSearch(q){
  const url = OFF_BASE + "/cgi/search.pl?search_terms=" + encodeURIComponent(q) +
    "&search_simple=1&action=process&json=1&page_size=15" +
    "&fields=code,product_name,product_name_en,brands,serving_size,nutriments";
  const r = await fetch(url, {headers:{Accept:"application/json"}});
  if(!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const out = [];
  for(const prod of (j.products || [])){
    const f = offNormalise(prod);
    if(f) out.push(f);
    if(out.length >= 10) break;
  }
  return out;
}

async function lookupCode(code){
  const out = $("scanOut");
  out.innerHTML = "";
  const saved = state.foods.find(f => f.code === code);
  if(saved){ showPortion(saved, "scanOut"); flash("Found in your saved foods"); return; }

  if(!navigator.onLine){
    out.innerHTML = '<p class="err">You\'re offline, so the product database can\'t be reached. Enter the numbers off the pack by hand and it\'ll be saved for next time.</p>';
    return;
  }
  const th = document.createElement("div");
  th.className = "thinking";
  th.innerHTML = '<span class="dot"></span><span></span>';
  th.children[1].textContent = "Looking up " + code + "…";
  out.appendChild(th);
  try{
    const f = await offProduct(code);
    out.innerHTML = "";
    if(!f){
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Barcode " + code + " isn't in Open Food Facts, or has no nutrition data. Enter it by hand below and it's saved for next time — you can also add it to openfoodfacts.org so the next person finds it.";
      out.appendChild(p);
      $("mName").focus();
      return;
    }
    showPortion(f, "scanOut");
    const src = document.createElement("p");
    src.className = "srcline";
    src.textContent = "Barcode " + code + " · data from Open Food Facts (ODbL)";
    out.appendChild(src);
  }catch(e){
    out.innerHTML = "";
    const p = document.createElement("p");
    p.className = "err";
    p.textContent = "Couldn't reach Open Food Facts. Check your connection and try again, or enter the numbers by hand.";
    out.appendChild(p);
  }
}

/* ============================ barcode scanner ============================ */
let scanStream = null, scanRAF = null, scanControls = null, scanBusy = false;

function scannerSupported(){
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

async function startScan(){
  if(scanBusy) return;
  scanBusy = true;
  const stage = $("scanStage");
  $("scanStart").hidden = true;
  $("scanStop").hidden = false;
  stage.innerHTML = '<div class="scanstage"><video playsinline muted autoplay></video>' +
    '<div class="scanframe"></div><div class="scanhint">Hold the barcode inside the box</div></div>';
  const video = stage.querySelector("video");

  try{
    scanStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}}});
    video.srcObject = scanStream;
    await video.play();
  }catch(e){
    stopScan();
    $("scanStage").innerHTML = '<p class="err">Couldn\'t open the camera. On a phone, make sure the page has camera permission; on a browser, the page has to be served over https. You can still type the barcode number below.</p>';
    scanBusy = false;
    return;
  }

  if("BarcodeDetector" in window){
    let detector;
    try{
      detector = new window.BarcodeDetector({formats:["ean_13","ean_8","upc_a","upc_e","code_128","code_39","itf"]});
    }catch(e){
      detector = new window.BarcodeDetector();
    }
    const tick = async ()=>{
      if(!scanStream) return;
      try{
        const codes = await detector.detect(video);
        if(codes && codes.length && codes[0].rawValue){
          const code = String(codes[0].rawValue).replace(/\D/g,"");
          if(code.length >= 8){ onCode(code); return; }
        }
      }catch(e){ /* a dropped frame is normal */ }
      scanRAF = requestAnimationFrame(tick);
    };
    scanRAF = requestAnimationFrame(tick);
  } else {
    const ok = await loadZXing();
    if(!ok){
      stopScan();
      $("scanStage").innerHTML = '<p class="hint">This browser can\'t decode barcodes from the camera. Chrome on Android can, and so can the Plate Android app. Type the number below instead — it works everywhere.</p>';
      scanBusy = false;
      return;
    }
    try{
      const reader = new window.ZXingBrowser.BrowserMultiFormatReader();
      scanControls = await reader.decodeFromVideoElement(video, (result)=>{
        if(result && result.getText){
          const code = String(result.getText()).replace(/\D/g,"");
          if(code.length >= 8) onCode(code);
        }
      });
    }catch(e){
      stopScan();
      $("scanStage").innerHTML = '<p class="hint">The barcode reader didn\'t start. Type the number below instead.</p>';
    }
  }
  scanBusy = false;
}

function onCode(code){
  stopScan();
  $("codeIn").value = code;
  if(navigator.vibrate) { try{ navigator.vibrate(40); }catch(e){} }
  lookupCode(code);
}

function stopScan(){
  if(scanRAF){ cancelAnimationFrame(scanRAF); scanRAF = null; }
  if(scanControls){ try{ scanControls.stop(); }catch(e){} scanControls = null; }
  if(scanStream){ scanStream.getTracks().forEach(t=>{ try{ t.stop(); }catch(e){} }); scanStream = null; }
  $("scanStage").innerHTML = "";
  $("scanStart").hidden = false;
  $("scanStop").hidden = true;
}

/* The CI build drops ZXing into vendor/ for browsers without BarcodeDetector.
   If it isn't there, the scanner falls back to typing the number. */
let zxingTried = false;
function loadScript(src){
  return new Promise(res=>{
    const s = document.createElement("script");
    s.src = src;
    s.onload = ()=>res(true);
    s.onerror = ()=>res(false);
    document.head.appendChild(s);
  });
}
async function loadZXing(){
  if(window.ZXingBrowser) return true;
  if(zxingTried) return !!window.ZXingBrowser;
  zxingTried = true;
  const a = await loadScript("vendor/zxing-library.js");
  if(!a) return false;
  const b = await loadScript("vendor/zxing-browser.js");
  return !!(b && window.ZXingBrowser);
}

/* ============================ meal planner ============================ */
/* Templates are [food name, base grams] lists sized for roughly a 2,000 kcal day.
   The solver below stretches them to whatever this person's targets are.
   Every lunch and dinner carries a lean protein so high-protein targets stay reachable. */
/* Role per item: p = the protein, e = the starch or fat that carries the calories,
   v = produce and drinks, which hold their size so the plate stays believable. */
const T_BREAKFAST = [
  {styles:["jamaican"], veg:true,  items:[["Cornmeal porridge",350,"e"],["Whey protein powder",20,"p"],["Banana",110,"v"]]},
  {styles:["jamaican"], veg:false, items:[["Ackee and saltfish",180,"e"],["Saltfish, soaked and boiled",50,"p"],["Boiled dumpling",55,"e"],["Fried plantain",50,"v"]]},
  {styles:["jamaican"], veg:true,  items:[["Hardo bread",55,"e"],["Egg, boiled",110,"p"],["Whole milk",220,"e"]]},
  {styles:["mixed","light"], veg:true, items:[["Oats, dry",55,"e"],["Whole milk",220,"e"],["Banana",110,"v"],["Peanut butter",16,"e"]]},
  {styles:["mixed"], veg:true,  items:[["Greek yogurt, plain",220,"p"],["Granola",40,"e"],["Pineapple",110,"v"]]},
  {styles:["light"], veg:true,  items:[["Greek yogurt, plain",200,"p"],["Egg, boiled",55,"p"],["Almonds",18,"e"],["Apple",160,"v"]]},
  {styles:["jamaican","mixed"], veg:true, items:[["Peanut porridge",330,"e"],["Greek yogurt, plain",120,"p"],["Guava",90,"v"]]}
];
const T_LUNCH = [
  {styles:["jamaican"], veg:false, items:[["Rice and peas",200,"e"],["Brown stew chicken",150,"p"],["Jerk chicken, skinless",70,"p"],["Cabbage, cooked",120,"v"]]},
  {styles:["jamaican"], veg:false, items:[["Bammy",70,"e"],["Steamed fish",190,"p"],["Callaloo, steamed",140,"v"]]},
  {styles:["jamaican"], veg:false, items:[["White rice, cooked",190,"e"],["Curry goat",150,"p"],["Saltfish, soaked and boiled",45,"p"],["Carrot",80,"v"]]},
  {styles:["jamaican","mixed"], veg:true, items:[["Rice and peas",200,"e"],["Red peas (kidney beans), cooked",170,"e"],["Tofu, firm",110,"p"],["Callaloo, steamed",140,"v"]]},
  {styles:["mixed"], veg:false, items:[["Pasta, cooked",190,"e"],["Chicken breast, grilled",160,"p"],["Broccoli, cooked",140,"v"]]},
  {styles:["light"], veg:false, items:[["Tuna, canned in water",150,"p"],["Whole wheat bread",55,"e"],["Avocado (pear)",50,"e"],["Lettuce",70,"v"],["Tomato",100,"v"]]},
  {styles:["light","mixed"], veg:true, items:[["Lentils, cooked",200,"e"],["Greek yogurt, plain",120,"p"],["Brown rice, cooked",160,"e"],["Spinach, cooked",140,"v"]]}
];
const T_DINNER = [
  {styles:["jamaican"], veg:false, items:[["Yellow yam, boiled",160,"e"],["Green banana, boiled",110,"e"],["Jerk chicken, skinless",170,"p"],["Callaloo, steamed",140,"v"]]},
  {styles:["jamaican"], veg:false, items:[["Rice and peas",180,"e"],["Escovitch fried fish",160,"p"],["Steamed fish",60,"p"],["Pumpkin, cooked",140,"v"]]},
  {styles:["jamaican"], veg:false, items:[["Breadfruit, roasted",160,"e"],["Stewed oxtail",130,"p"],["Saltfish, soaked and boiled",45,"p"],["Cabbage, cooked",140,"v"]]},
  {styles:["jamaican","mixed"], veg:true, items:[["Yellow yam, boiled",160,"e"],["Ital stew",300,"e"],["Tofu, firm",130,"p"],["Callaloo, steamed",140,"v"]]},
  {styles:["mixed"], veg:false, items:[["Sweet potato, boiled",190,"e"],["Salmon, cooked",150,"p"],["Shrimp, cooked",60,"p"],["Spinach, cooked",140,"v"]]},
  {styles:["light"], veg:false, items:[["Steamed fish",200,"p"],["Sweet potato, boiled",130,"e"],["Pumpkin, cooked",160,"v"],["Broccoli, cooked",140,"v"]]},
  {styles:["light","mixed"], veg:true, items:[["Tofu, firm",180,"p"],["Brown rice, cooked",160,"e"],["Lentils, cooked",120,"e"],["Broccoli, cooked",140,"v"]]}
];
const T_SNACK = [
  {styles:["jamaican","mixed","light"], veg:true, items:[["Greek yogurt, plain",140,"p"],["Banana",110,"v"],["Peanut butter",14,"e"]]},
  {styles:["jamaican","mixed","light"], veg:true, items:[["Almonds",25,"e"],["Orange",140,"v"]]},
  {styles:["mixed","light"], veg:true, items:[["Greek yogurt, plain",170,"p"],["Whey protein powder",12,"p"]]},
  {styles:["jamaican"], veg:true, items:[["Guava",90,"v"],["Cashews",22,"e"],["Whey protein powder",14,"p"]]},
  {styles:["jamaican","light"], veg:true, items:[["Coconut water",300,"v"],["Egg, boiled",55,"p"],["Papaya",130,"v"]]}
];

const foodByName = {};
for(const f of FOODS) foodByName[f.name] = f;

function pickTemplates(pool, style, veg){
  const hit = pool.filter(t => t.styles.indexOf(style) > -1 && (!veg || t.veg));
  if(hit.length) return hit;
  const any = pool.filter(t => !veg || t.veg);
  return any.length ? any : pool;
}

const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));

/* Portions stay inside these multiples of the template's own sizes, so no plate
   ever comes back with 800 g of porridge. */
const BOUNDS = {p:[0.60, 1.90], e:[0.60, 1.70], v:[1, 1]};

/* Hit calories and protein at once: scale protein-dense foods by `a` and
   energy-dense foods by `b`, solving the 2x2 system, then clamp to sane portions. */
function solveDay(rows, T){
  let Kp=0,Pp=0, Ke=0,Pe=0, Kv=0,Pv=0;
  for(const r of rows){
    const k = r.grams/100;
    if(r.role === "p"){ Kp += r.f.kcal*k; Pp += r.f.p*k; }
    else if(r.role === "e"){ Ke += r.f.kcal*k; Pe += r.f.p*k; }
    else { Kv += r.f.kcal*k; Pv += r.f.p*k; }
  }
  const kTar = T.kcal - Kv, pTar = T.protein - Pv;
  let a = 1, b = 1;
  const D = Kp*Pe - Ke*Pp;

  if(Math.abs(D) > 1){
    a = (kTar*Pe - pTar*Ke) / D;
    b = (pTar*Kp - kTar*Pp) / D;
  }
  a = clamp(a, BOUNDS.p[0], BOUNDS.p[1]);
  b = clamp(b, BOUNDS.e[0], BOUNDS.e[1]);

  /* If a bound bit, give calories the last word — being on target matters more
     than the exact protein split, and the shortfall gets reported. */
  if(Ke > 0) b = clamp((kTar - a*Kp) / Ke, BOUNDS.e[0], BOUNDS.e[1]);
  if(Kp > 0 && Math.abs(kTar - (a*Kp + b*Ke)) > T.kcal*0.015){
    a = clamp((kTar - b*Ke) / Kp, BOUNDS.p[0], BOUNDS.p[1]);
    if(Ke > 0) b = clamp((kTar - a*Kp) / Ke, BOUNDS.e[0], BOUNDS.e[1]);
  }

  for(const r of rows) r.factor = r.role === "p" ? a : r.role === "e" ? b : 1;
}

/* Templates are written for about a 2,050 kcal day. Someone eating 3,000 has a
   bigger plate of everything, so the whole template grows before the solver
   makes its correction — that keeps each factor near 1 and the portions sane. */
function rowsOf(tpl, appetite){
  const rows = [];
  for(const [name, grams, role] of tpl.items){
    const f = foodByName[name];
    if(f) rows.push({f, grams: grams * appetite, role: role || "e", factor: 1});
  }
  return rows;
}

function mealTotals(rows){
  const t = {kcal:0,protein:0,carbs:0,fat:0,fiber:0};
  for(const r of rows){
    const k = r.grams * r.factor / 100;
    t.kcal += r.f.kcal*k; t.protein += r.f.p*k; t.carbs += r.f.c*k; t.fat += r.f.f*k; t.fiber += (r.f.fib||0)*k;
  }
  return t;
}

function buildPlan(days, style, veg){
  const T = targets(state.profile);
  const pools = {
    breakfast: pickTemplates(T_BREAKFAST, style, veg),
    lunch: pickTemplates(T_LUNCH, style, veg),
    dinner: pickTemplates(T_DINNER, style, veg),
    snack: pickTemplates(T_SNACK, style, veg)
  };
  const offs = {breakfast:0, lunch:1, dinner:2};
  const appetite = clamp(T.kcal / 2050, 0.60, 1.60);
  const snackCount = T.kcal < 1450 ? 0 : T.kcal < 2500 ? 1 : 2;

  const out = [];
  for(let d=0; d<days; d++){
    const day = {breakfast:[], lunch:[], dinner:[], snack:[]};
    for(const m of ["breakfast","lunch","dinner"]){
      const pool = pools[m];
      day[m] = rowsOf(pool[(d + offs[m]) % pool.length], appetite);
    }
    for(let s=0; s<snackCount; s++){
      const pool = pools.snack;
      day.snack = day.snack.concat(rowsOf(pool[(d*2 + s) % pool.length], appetite));
    }
    const all = [];
    for(const m of MEALS) for(const r of day[m]) all.push(r);
    solveDay(all, T);
    out.push(day);
  }
  return {days: out, T};
}

function renderPlan(plan){
  const out = $("planOut");
  out.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "rows";
  const shopping = {};
  const shortDays = [];

  plan.days.forEach((day, di)=>{
    let dk = 0, dp = 0;
    for(const m of MEALS){ const t = mealTotals(day[m]); dk += t.kcal; dp += t.protein; }
    if(dp < plan.T.protein * 0.90) shortDays.push(di+1);

    const card = document.createElement("div");
    card.className = "planday";
    const head = document.createElement("div");
    head.className = "pdh";
    head.innerHTML = '<span></span><span class="pk"></span>';
    head.children[0].textContent = "Day " + (di+1);
    head.children[1].textContent = round(dk) + " kcal · " + round(dp) + " g protein";
    card.appendChild(head);

    for(const m of MEALS){
      const rows = day[m];
      if(!rows.length) continue;
      const sec = document.createElement("div");
      sec.className = "planmeal";
      sec.innerHTML = '<div class="pm"></div><ul></ul>';
      sec.children[0].textContent = MEAL_LABEL[m] + " · " + round(mealTotals(rows).kcal) + " kcal";
      const ul = sec.children[1];
      for(const r of rows){
        const g = Math.round(r.grams * r.factor / 5) * 5 || 5;
        const li = document.createElement("li");
        li.textContent = r.f.name + " — " + g + " g (" + round(r.f.kcal*g/100) + " kcal)";
        ul.appendChild(li);
        shopping[r.f.name] = (shopping[r.f.name] || 0) + g;
      }
      card.appendChild(sec);
    }

    const foot = document.createElement("div");
    foot.className = "planmeal";
    const b = document.createElement("button");
    b.className = "btn ghost sm";
    b.textContent = "Log this day to " + prettyDate(viewDate).toLowerCase();
    b.addEventListener("click", ()=>{
      for(const m of MEALS) for(const r of day[m]){
        const g = Math.round(r.grams * r.factor / 5) * 5 || 5, k = g/100;
        addItem(m, {name:r.f.name, portion:g + " g", kcal:r.f.kcal*k, protein:r.f.p*k,
          carbs:r.f.c*k, fat:r.f.f*k, fiber:(r.f.fib||0)*k, src:"plan"});
      }
      flash("Logged to " + prettyDate(viewDate).toLowerCase());
      goTab("today");
    });
    foot.appendChild(b);
    card.appendChild(foot);
    wrap.appendChild(card);
  });

  if(shortDays.length){
    const n = document.createElement("div");
    n.className = "verdict v-warn";
    n.innerHTML = '<div class="vh"></div><div class="vb"></div>';
    n.children[0].textContent = "Protein falls short";
    n.children[1].textContent = "Day" + (shortDays.length>1 ? "s " : " ") + shortDays.join(", ") +
      " lands under your " + round(plan.T.protein) + " g protein target. At this calorie level that's hard to fix with food alone — " +
      "a scoop of whey or an extra two eggs closes the gap without adding much.";
    wrap.appendChild(n);
  }

  const names = Object.keys(shopping).sort();
  if(names.length){
    const s = document.createElement("div");
    s.className = "planday";
    s.innerHTML = '<div class="pdh"><span>Shopping list</span><span class="pk"></span></div><div class="planmeal"><ul></ul></div>';
    s.querySelector(".pk").textContent = names.length + " items";
    const ul = s.querySelector("ul");
    for(const n of names){
      const li = document.createElement("li");
      const g = shopping[n];
      li.textContent = n + " — " + (g >= 1000 ? r1(g/1000) + " kg" : g + " g");
      ul.appendChild(li);
    }
    wrap.appendChild(s);
  }
  out.appendChild(wrap);
}

/* ============================ backup ============================ */
function exportBackup(){
  const payload = {app:"plate", version:1, exported:new Date().toISOString()};
  for(const k of KEYS) payload[k] = state[k];
  const text = JSON.stringify(payload, null, 2);
  const name = "plate-backup-" + todayKey() + ".json";

  /* A WebView won't download a blob: URL, so the Android build takes the text directly. */
  if(window.PlateAndroid && typeof window.PlateAndroid.saveText === "function"){
    const where = window.PlateAndroid.saveText(name, text);
    $("dataMsg").textContent = where ? "Backup saved to " + where : "Couldn't write the backup to storage.";
    return;
  }

  const blob = new Blob([text], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
  $("dataMsg").textContent = "Backup downloaded.";
}

function importBackup(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const data = JSON.parse(String(reader.result));
      if(!data || data.app !== "plate") throw new Error("not a Plate backup");
      for(const k of KEYS) if(data[k] != null) state[k] = data[k];
      normalise();
      for(const k of KEYS) save(k);
      renderAll();
      $("dataMsg").textContent = "Backup restored.";
    }catch(e){
      $("dataMsg").textContent = "That file isn't a Plate backup.";
    }
  };
  reader.onerror = ()=>{ $("dataMsg").textContent = "Couldn't read that file."; };
  reader.readAsText(file);
}

/* ============================ chrome ============================ */
let flashTimer = null;
function flash(msg){
  let el = $("toast");
  if(!el){
    el = document.createElement("div");
    el.id = "toast";
    el.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(20px + env(safe-area-inset-bottom,0px));" +
      "background:var(--ink);color:var(--bg);padding:9px 16px;border-radius:99px;font-size:13px;font-weight:600;z-index:50;box-shadow:var(--shadow)";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(()=>{ el.hidden = true; }, 2200);
}

const TABS = ["today","add","plan","you"];
function goTab(name){
  if(TABS.indexOf(name) < 0) name = "today";
  if(name !== "add") stopScan();
  for(const t of TABS) $("tab-"+t).hidden = (t !== name);
  document.querySelectorAll("nav.tabs button").forEach(b=>b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  try{ if(location.hash.slice(1) !== name) history.replaceState(null,"","#"+name); }catch(e){}
  window.scrollTo(0,0);
  if(name === "you") renderYou();
}

function readProfileForm(){
  const p = state.profile;
  const imperial = p.units === "imperial";
  p.sex = $("pSex").value;
  p.age = Math.max(14, Math.min(100, Number($("pAge").value) || p.age));
  if(imperial){
    const cm = ((Number($("pFt").value)||0)*12 + (Number($("pIn").value)||0)) * 2.54;
    if(cm > 100) p.ht = cm;
    const lb = Number($("pLb").value) || 0;
    if(lb > 50) p.wt = lb / 2.20462;
    const gl = Number($("pGoalWt").value) || 0;
    p.goalWt = gl > 50 ? gl / 2.20462 : null;
  } else {
    const ht = Number($("pHt").value) || 0;
    if(ht > 100) p.ht = ht;
    const wt = Number($("pWt").value) || 0;
    if(wt > 25) p.wt = wt;
    const gw = Number($("pGoalWt").value) || 0;
    p.goalWt = gw > 25 ? gw : null;
  }
  p.act = Number($("pAct").value) || 1.55;
  p.goal = $("pGoal").value;
  if($("pPace").value) p.pace = Number($("pPace").value);
  save("profile");
  renderYou();
  renderToday();
}

/* ============================ install prompt ============================
   Chrome hands us a real install event. Safari never does, so on iPhone the
   only honest thing is to show the two taps that actually do it. */
let deferredInstall = null;
const DISMISS_KEY = "plate_install_dismissed";
const DISMISS_DAYS = 14;

function isInstalled(){
  try{
    return window.matchMedia("(display-mode: standalone)").matches ||
           window.matchMedia("(display-mode: fullscreen)").matches ||
           window.matchMedia("(display-mode: minimal-ui)").matches ||
           navigator.standalone === true;
  }catch(e){ return false; }
}
function isIOS(){
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) ||
         (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isIOSSafari(){
  const ua = navigator.userAgent || "";
  return isIOS() && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}
function dismissedRecently(){
  try{
    const t = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return t > 0 && (Date.now() - t) < DISMISS_DAYS * 864e5;
  }catch(e){ return false; }
}
function rememberDismiss(){
  try{ localStorage.setItem(DISMISS_KEY, String(Date.now())); }catch(e){}
}

function iosSteps(){
  return [
    'Tap <span class="shareglyph" aria-hidden="true">↑</span> <b>Share</b> at the bottom of Safari',
    'Scroll down and tap <b>Add to Home Screen</b>',
    'Tap <b>Add</b> — Plate lands on your home screen'
  ];
}

/* The sheet at the bottom, and the permanent row in the You tab. */
function showSheet(mode){
  const sheet = $("installSheet"), steps = $("installSteps"), go = $("installGo");
  if(mode === "prompt"){
    steps.hidden = true;
    go.hidden = false;
    $("installBody").textContent = "Keep it on your home screen — it opens full screen and works without a signal.";
  } else {
    steps.innerHTML = iosSteps().map(s => "<li>" + s + "</li>").join("");
    steps.hidden = false;
    go.hidden = true;
    $("installBody").textContent = "Two taps and it lives on your home screen, full screen and offline-ready.";
  }
  sheet.hidden = false;
}

function renderInstallCard(){
  const card = $("installCard");
  if(isInstalled()){
    card.hidden = false;
    $("installCardBody").textContent = "Plate is installed on this device — you're running the installed copy.";
    $("installCardGo").hidden = true;
    return;
  }
  if(deferredInstall){
    card.hidden = false;
    $("installCardBody").textContent = "Put Plate on your home screen so it opens full screen and works offline.";
    $("installCardGo").hidden = false;
    return;
  }
  if(isIOSSafari()){
    card.hidden = false;
    $("installCardBody").innerHTML = "On iPhone, Safari does the installing: " + iosSteps().join(", then ").replace(/<span[^>]*>.*?<\/span> /, "") + ".";
    $("installCardGo").hidden = true;
    return;
  }
  card.hidden = true;
}

async function runInstall(){
  if(!deferredInstall) return;
  const e = deferredInstall;
  deferredInstall = null;
  $("installSheet").hidden = true;
  try{
    e.prompt();
    const res = await e.userChoice;
    if(res && res.outcome === "dismissed") rememberDismiss();
  }catch(err){}
  renderInstallCard();
}

function setupInstall(){
  $("installGo").addEventListener("click", runInstall);
  $("installCardGo").addEventListener("click", runInstall);
  $("installNo").addEventListener("click", ()=>{
    $("installSheet").hidden = true;
    rememberDismiss();
  });

  window.addEventListener("beforeinstallprompt", e=>{
    e.preventDefault();
    deferredInstall = e;
    renderInstallCard();
    if(!isInstalled() && !dismissedRecently()) showSheet("prompt");
  });

  window.addEventListener("appinstalled", ()=>{
    deferredInstall = null;
    $("installSheet").hidden = true;
    rememberDismiss();
    renderInstallCard();
    flash("Plate is installed");
  });

  /* Safari fires nothing, so after a moment of real use, show the steps. */
  if(isIOSSafari() && !isInstalled() && !dismissedRecently()){
    setTimeout(()=>{ if(!isInstalled()) showSheet("ios"); }, 3500);
  }
  renderInstallCard();
}

function wire(){
  document.querySelectorAll("nav.tabs button").forEach(b=>b.addEventListener("click", ()=>goTab(b.dataset.tab)));
  document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click", ()=>goTab(b.dataset.goto)));

  $("prevDay").addEventListener("click", ()=>{ viewDate = shiftKey(viewDate,-1); renderToday(); });
  $("nextDay").addEventListener("click", ()=>{
    if(viewDate >= todayKey()) return;
    viewDate = shiftKey(viewDate,1); renderToday();
  });

  document.querySelectorAll("#mealSeg button").forEach(b=>{
    b.addEventListener("click", ()=>{ activeMeal = b.dataset.meal; renderMealSeg(); });
  });
  document.querySelectorAll("#unitSeg button").forEach(b=>{
    b.addEventListener("click", ()=>{ state.profile.units = b.dataset.unit; save("profile"); renderYou(); });
  });
  ["pSex","pAge","pHt","pWt","pFt","pIn","pLb","pAct","pGoal","pPace","pGoalWt"].forEach(id=>{
    $(id).addEventListener("change", readProfileForm);
  });

  $("foodSearch").addEventListener("input", e=>renderSearch(e.target.value));

  $("scanStart").addEventListener("click", startScan);
  $("scanStop").addEventListener("click", stopScan);
  $("codeGo").addEventListener("click", ()=>{
    const code = $("codeIn").value.replace(/\D/g,"");
    if(code.length < 8){ flash("That doesn't look like a barcode"); return; }
    lookupCode(code);
  });
  $("codeIn").addEventListener("keydown", e=>{ if(e.key === "Enter") $("codeGo").click(); });

  $("mAdd").addEventListener("click", ()=>{
    const name = $("mName").value.trim();
    const kcal = Number($("mKcal").value);
    const err = $("mErr");
    if(!name || !(kcal > 0)){
      err.hidden = false;
      err.textContent = "A name and a calorie figure are needed. The rest can stay blank.";
      return;
    }
    err.hidden = true;
    const serv = $("mServ").value.trim() || "1 serving";
    const item = {name, portion:serv, kcal, protein:Number($("mP").value)||0,
      carbs:Number($("mC").value)||0, fat:Number($("mF").value)||0, fiber:0, src:"manual"};
    addItem(activeMeal, item);
    if($("mSave").checked){
      const code = $("codeIn").value.replace(/\D/g,"");
      state.foods.push({id:uid(), name, cat:"Saved", kcal, p:item.protein, c:item.carbs, f:item.fat, fib:0,
        portion:100, plabel:serv, servingMode:true, code: code.length >= 8 ? code : undefined});
      save("foods"); renderMyFoods();
    }
    ["mName","mServ","mKcal","mP","mC","mF"].forEach(id=>{ $(id).value = ""; });
    flash("Added to " + MEAL_LABEL[activeMeal].toLowerCase());
    goTab("today");
  });

  $("wAdd").addEventListener("click", ()=>{
    const raw = Number($("wVal").value);
    if(!(raw > 0)){ flash("Enter a weight first"); return; }
    const kg = state.profile.units === "imperial" ? raw/2.20462 : raw;
    if(kg < 25 || kg > 350){ flash("That doesn't look right"); return; }
    const d = todayKey();
    state.weights = state.weights.filter(w=>w.d !== d);
    state.weights.push({d, kg});
    state.weights.sort((a,b)=> a.d < b.d ? -1 : 1);
    if(state.weights.length > 400) state.weights = state.weights.slice(-400);
    state.profile.wt = kg;
    save("weights"); save("profile");
    $("wVal").value = "";
    renderYou(); renderToday();
    flash("Weight logged");
  });

  $("planGo").addEventListener("click", ()=>{
    const days = Number($("planDays").value) || 3;
    renderPlan(buildPlan(days, $("planStyle").value, $("planVeg").checked));
  });

  $("expBtn").addEventListener("click", exportBackup);
  $("impBtn").addEventListener("click", ()=>$("impFile").click());
  $("impFile").addEventListener("change", e=>{
    const f = e.target.files && e.target.files[0];
    if(f) importBackup(f);
    e.target.value = "";
  });

  setupInstall();

  const setOffline = ()=>{
    $("scanOffline").innerHTML = navigator.onLine ? "" :
      '<div class="offline">Offline — the product database is unreachable, but the food list and everything else still works.</div>';
  };
  window.addEventListener("online", setOffline);
  window.addEventListener("offline", setOffline);
  setOffline();

  if(!scannerSupported()) $("scanStart").disabled = true;

  const h = (location.hash || "").slice(1);
  goTab(TABS.indexOf(h) > -1 ? h : "today");
}

/* ============================ boot ============================ */
for(const k of KEYS){ const v = lsGet(k); if(v != null) state[k] = v; }
normalise();
wire();
renderAll();

/* Inside the Android app the assets are already local, so the worker adds nothing. */
const IN_ANDROID_APP = location.hostname === "appassets.androidplatform.net";
if("serviceWorker" in navigator && location.protocol !== "file:" && !IN_ANDROID_APP){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  });
}
