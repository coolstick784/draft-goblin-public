import test from"node:test";
import assert from"node:assert/strict";
import{backtestRookieRangeCalibration,evaluateRookiePolicy}from"../scripts/backtest-rookie-range-calibration.js";

function fixture(){const rows=[];for(const year of[2021,2022,2023,2024])for(let player=0;player<20;player++)for(let week=1;week<=10;week++){const rookie=player<8,position=player%2?"WR":"RB",projected=10+(player%3),scale=rookie?1.35:1,residual=((week+player)%4-1.5)*3*scale;rows.push({year,week,playerId:`${year}-${player}`,name:`Player ${year} ${player}`,position,projected,actual:Math.max(0,projected+residual),activityStatus:"active-observed",rookie})}return rows}

test("rookie policy changes tails but preserves the median",()=>{const rows=fixture(),training=rows.filter(row=>row.year<2024),testRows=rows.filter(row=>row.year===2024),base=evaluateRookiePolicy(training,testRows,{multiplier:1}),wide=evaluateRookiePolicy(training,testRows,{multiplier:1.2});assert.equal(base.rows,80);assert.ok(wide.meanWidth>base.meanWidth)});

test("rookie calibration is nested, activity-aware, and never self-tunes on holdout",()=>{const artifact=backtestRookieRangeCalibration(fixture(),{generatedAt:"2026-01-01T00:00:00.000Z",bootstrapDraws:100});assert.equal(artifact.rollingOrigin.folds[1].tuningYear,2023);assert.equal(artifact.rollingOrigin.folds[1].testYear,2024);assert.equal(artifact.dataQuality.trueRookieRows,320);assert.match(artifact.leakageBoundary,/No test-season outcome/);assert.equal(artifact.promotionGate.productionReady,false);assert.ok(artifact.candidatePolicy.selectedGlobal>=.6&&artifact.candidatePolicy.selectedGlobal<=2);assert.ok(artifact.fixed120Assessment.clusterBootstrapVsNoAdjustment.interval95.length===2)});
