import React, { Component, createRef } from 'react';
import { hot } from 'react-hot-loader/root';
import { Viewer } from 'resium';
import {
    TimeIntervalCollection,
    TimeInterval,
    JulianDate,
    TimeIntervalCollectionPositionProperty,
    SampledProperty,
    SampledPositionProperty,
    getTimestamp,
    ReferenceFrame,
    Cartesian3,
    Entity,
    PointGraphics,
    PathGraphics,
    Polyline,
    Color,
    CallbackProperty,
    PropertyBag,
    ClockRange,
    ConstantPositionProperty
} from 'cesium'
import { sgp4, twoline2satrec, gstime, propagate, eciToGeodetic, eciToEcf } from 'satellite.js';
const hits = require('./hits.json');
const csvData = require('./test-sat.csv');


class App extends Component {
    constructor(props) {
        super(props);
        this.ref = createRef();
    }

    componentDidMount() {
        if (this.ref.current && this.ref.current.cesiumElement) {
            this.viewer = this.ref.current.cesiumElement;

            const satMap = { };
            let minDate = null;
            let maxDate = null;
            for (const csvRow of csvData) {
                const d = new Date(csvRow['dt']);
                if (minDate == null) {
                    minDate = d.getTime();
                    maxDate = d.getTime();
                }
                if (d.getTime() < minDate) {
                    minDate = d.getTime();
                }
                if (d.getTime() > maxDate) {
                    maxDate = d.getTime();
                }
                csvRow['dt'] = d;
                if (satMap.hasOwnProperty(csvRow['satellite'])) {
                    const satObj = satMap[csvRow['satellite']];
                    satObj.tles.push(csvRow);
                } else {
                    satMap[csvRow['satellite']] = {
                        satellite: csvRow.satellite,
                        tles: [csvRow]
                    };
                }
            }

            const shipHits = {};
            for (const hit of hits.items) {
                hit.time = new Date(hit.millis70);
                if (shipHits.hasOwnProperty(hit.imo)) {
                    const satObj = shipHits[hit['imo']];
                    satObj.points.push(hit);
                } else {
                    shipHits[hit.imo] = {
                        id: hit.imo,
                        points: [hit]
                    }
                }
            }

            const clock = this.viewer.clock;
            clock.startTime = JulianDate.fromDate(new Date(minDate));
            clock.stopTime = JulianDate.fromDate(new Date(maxDate));
            clock.currentTime = JulianDate.fromDate(new Date(minDate));
            clock.clockRange = ClockRange.LOOP_STOP;
            for (const key of Object.keys(satMap)) {
                const satObj = satMap[key];
                satObj.tles = satObj.tles.sort((a, b) => a.dt - b.dt);


                const tInts = [];
                const pInts = [];
                for (const [i, tle] of satObj.tles.entries()) {
                    let nextTLE = null;
                    if (i + 1 < satObj.tles.length - 1) {
                        nextTLE = satObj.tles[i + 1];
                    }

                    if (tle && nextTLE) {
                        const startTime = JulianDate.fromDate(tle.dt);
                        const endTime = JulianDate.fromDate(nextTLE['dt']);
                        const timeInt = new TimeInterval({
                            start: startTime,
                            stop: endTime,
                            data: tle,
                            isStartIncluded: true,
                            isStopIncluded: false,
                        });
                        tInts.push(timeInt);

                        // Build position + velocity samples for satellite for interval
                        const sampledIntervalPos = new SampledPositionProperty(ReferenceFrame.FIXED, 0);
                        const secsRange = JulianDate.secondsDifference(endTime, startTime);
                        const sampleCount = 20;
                        const sampleInt = secsRange / sampleCount;
                        const satRec = twoline2satrec(tle['tleline1'], tle['tleline2']);
                        const cartPos = this.getSatellitePosition(tle.dt, satRec);
                        sampledIntervalPos.addSample(startTime, cartPos);
                        for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
                            const sampleTime = JulianDate.addSeconds(startTime, sampleInt * sampleIndex, new JulianDate());
                            const samplePos = this.getSatellitePosition(JulianDate.toDate(sampleTime), satRec);
                            sampledIntervalPos.addSample(sampleTime, samplePos);
                        }
                        const positionSampleInterval = new TimeInterval({
                            start: startTime,
                            stop: endTime,
                            isStartIncluded: true,
                            isStopIncluded: false,
                            data: sampledIntervalPos
                        });
                        pInts.push(positionSampleInterval);
                    } /*else if (tle) {
                        const startTime = JulianDate.fromDate(tle.dt);
                        let d = new Date(tle.dt.getTime());
                        d.setDate(d.getDate() + 7);
                        const endTime = JulianDate.fromDate(d);
                        const timeInt = new TimeInterval({
                            start: startTime,
                            stop: endTime,
                            data: tle,
                            isStartIncluded: true,
                            isStopIncluded: false,
                        });
                        tInts.push(timeInt);

                        const sampledIntervalPos = new SampledPositionProperty(ReferenceFrame.FIXED, 0);
                        const secsRange = JulianDate.secondsDifference(endTime, startTime);
                        const sampleCount = 20;
                        const sampleInt = secsRange / sampleCount;
                        const satRec = twoline2satrec(tle['tleline1'], tle['tleline2']);
                        const cartPos = this.getSatellitePosition(tle.dt, satRec);
                        sampledIntervalPos.addSample(startTime, cartPos);
                        for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
                            const sampleTime = JulianDate.addSeconds(startTime, sampleInt * sampleIndex, new JulianDate());
                            const samplePos = this.getSatellitePosition(JulianDate.toDate(sampleTime), satRec);
                            sampledIntervalPos.addSample(sampleTime, samplePos);
                        }
                        const positionSampleInterval = new TimeInterval({
                            start: startTime,
                            stop: endTime,
                            isStartIncluded: true,
                            data: sampledIntervalPos
                        });
                        pInts.push(positionSampleInterval);
                    }*/
                }
                satObj.tleCollection = new TimeIntervalCollection(tInts);
                const propBag = new PropertyBag();
                propBag.addProperty('positionCollection', pInts);
                const tleProp = new CallbackProperty(function (time, result) {
                    const tle = this.tleCollection.findDataForIntervalContainingDate(time);
                    const satRec = twoline2satrec(tle['tleline1'], tle['tleline2']);
                    let posAndVel = propagate(satRec, JulianDate.toDate(time));
                    const gmst = gstime(JulianDate.toDate(time));
                    const geoPosVel = eciToGeodetic(posAndVel.position, gmst);
                    let longitude = geoPosVel.longitude,
                        latitude  = geoPosVel.latitude,
                        height    = geoPosVel.height * 1000;
                    return new Cartesian3.fromRadians(longitude, latitude, height);
                }, false);
                tleProp['positionCollection'] = new TimeIntervalCollection(pInts);
                tleProp['tleCollection'] = satObj.tleCollection;
                /*const cProp = new CallbackProperty(function (time, result)  {
                    if (this.lastSampledTime == null || JulianDate.secondsDifference(time, this.lastSampledTime) > 1) {
                        const sampledPosProp = this.positionCollection.findDataForIntervalContainingDate(time);
                        if (sampledPosProp) {
                            sampledPosProp.getValue(time, result);
                        }
                        this.lastSampledTime = time;
                    }
                    return result;
                }, false);
                cProp['positionCollection'] = new TimeIntervalCollection(pInts);
                cProp['tleCollection'] = satObj.tleCollection;*/
                const satEnt = new Entity({
                    id: `Satellite: ${satObj.satellite}`,
                    availability: satObj.tleCollection,
                    properties: propBag,
                    point: new PointGraphics({
                        color: Color.YELLOW,
                        pixelSize: 15
                    }),
                    position: tleProp
                });
                this.viewer.entities.add(satEnt);
            }

        }
    }

    getSatellitePosition(time, satRec) {
        let posAndVel = propagate(satRec, time);

        const gmst = gstime(time);
        const geoPosVel = eciToGeodetic(posAndVel.position, gmst);
        let longitude = geoPosVel.longitude,
            latitude  = geoPosVel.latitude,
            height    = geoPosVel.height * 1000;
        const cartPos = Cartesian3.fromRadians(longitude, latitude, height);
        return cartPos;
    }

    render() {
        return (
            <Viewer ref={this.ref} full>
            </Viewer>
        );
    }
}

export default hot(App);