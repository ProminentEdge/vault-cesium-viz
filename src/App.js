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
    ConstantPositionProperty,
    CustomDataSource,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    defined,
    EllipsoidGeodesic,
    Cartographic
} from 'cesium'
import { sgp4, twoline2satrec, gstime, propagate, eciToGeodetic, eciToEcf } from 'satellite.js';
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone')
dayjs.extend(utc);
dayjs.extend(timezone);

dayjs.tz.setDefault('America/New_York');

const hits = require('./hits_new.csv');
const csvData2 = require('./test-sat2.csv');
const shipCSV = require('./AISTest.csv');


class App extends Component {
    constructor(props) {
        super(props);
        this.ref = createRef();
        this.coloredSats = [];
        this.hitSource = null;
        this.satelliteSource = null;
        this.shipSource = null;
        this.lastUpdateTime = null;
    }

    componentDidMount() {
        if (this.ref.current && this.ref.current.cesiumElement) {
            this.viewer = this.ref.current.cesiumElement;

            const satMap = { };
            let minDate = null;
            let maxDate = null;
            const csvs = [csvData2];
            for (const satData of csvs) {
                for (const csvRow of satData) {
                    const d = dayjs(Number(csvRow.millis70), 'YYYY-MM-DD HH:mm:ss', 'America/New_York').toDate();
                    if (minDate == null || d.getTime() < minDate) {
                        minDate = d.getTime();
                    }
                    if (maxDate == null || d.getTime() > maxDate) {
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
            }

            const shipData = {};
            for (const shipRow of shipCSV) {
                shipRow.time = dayjs(shipRow.basedatetime, 'YYYY-MM-DDTHH:mm:ss', 'America/New_York').toDate();
                if (shipData.hasOwnProperty(shipRow.imo)) {
                    const shipObj = shipData[shipRow.imo];
                    shipObj.points.push(shipRow);
                } else {
                    shipData[shipRow.imo] = {
                        id: shipRow.imo,
                        name: shipRow.vesselname,
                        points: [],
                    };
                }
            }
            let shipMinDate = null;
            let shipMaxDate = null;
            this.shipSource = new CustomDataSource('ships');
            this.satelliteSource = new CustomDataSource('satellites');
            for (const key of Object.keys(shipData)) {
                const ship = shipData[key];
                if (ship.points.length < 2) {
                    //Ignore ships that don't have point data.
                    continue;
                }
                ship.points = ship.points.sort((a,b) => a.time - b.time);
                const sMin = ship.points[0].time.getTime();
                const sMax = ship.points[ship.points.length - 1].time.getTime();
                if (shipMinDate == null || sMin < shipMinDate) {
                    shipMinDate = sMin;
                }
                if (shipMaxDate == null || sMax > shipMaxDate) {
                    shipMaxDate = sMax;
                }
                const shipSamplePoints = ship.points.map((point) => {
                    return {
                        position: Cartesian3.fromDegrees(Number(point.lon), Number(point.lat)),
                        time: JulianDate.fromDate(point.time),
                    };
                });
                const sampledPos = new SampledPositionProperty();
                for (const samplePoint of shipSamplePoints) {
                    sampledPos.addSample(samplePoint.time, samplePoint.position );
                }
                const shipInterval = new TimeInterval({
                    start: JulianDate.fromDate(dayjs(sMin, 'YYYY-MM-DDTHH:mm:ss', 'America/New_York').toDate()),
                    stop: JulianDate.fromDate(dayjs(sMax, 'YYYY-MM-DDTHH:mm:ss', 'America/New_York').toDate()),
                    isStartIncluded: true,
                    isStopIncluded: true,
                });
                const shipAvailability = new TimeIntervalCollection([shipInterval]);
                const shipEntity = new Entity({
                    availability: shipAvailability,
                    id: `${ship.name} (${ship.id})`,
                    name:`${ship.name} (${ship.id})`,
                    position: sampledPos,
                    point: new PointGraphics({
                        color: Color.ALICEBLUE,
                        pixelSize: 12,
                    }),
                    path: new PathGraphics({
                        material: Color.BEIGE,
                        width: 3,
                        leadTime: 3600,
                        trailTime: 3600,
                    })
                });
                this.shipSource.entities.add(shipEntity);
            }
            this.viewer.dataSources.add(this.shipSource);


            const shipHits = {};
            for (const hit of hits) {
                hit.time = dayjs(Number(hit.millis70)).toDate();
                if (shipHits.hasOwnProperty(hit.imo)) {
                    const satObj = shipHits[hit.imo];
                    satObj.points.push(hit);
                } else {
                    shipHits[hit.imo] = {
                        id: hit.imo,
                        points: [hit]
                    }
                }
            }

            this.hitSource = new CustomDataSource('validationSource');
            const shipDatasource = new CustomDataSource('ships');
            for (const shipKey of Object.keys(shipHits)) {
                const shipObj = shipHits[shipKey];

                shipObj.points = shipObj.points.sort((a,b) => a.time - b.time);

                //TODO: For each sorted ship points generate hit/hole intervals.
                //TODO: Create entity collection for each ship?
                let index = 0;
                for (const point of shipObj.points) {
                    const pointProps = new PropertyBag();
                    pointProps.addProperty('time', point.time);
                    pointProps.addProperty('satellite', point.satName);
                    pointProps.addProperty('hit', point.isHit === "1");
                    pointProps.addProperty('satCoords', [Number(point.satLong), Number(point.satLat)]);
                    const shipPoint = new Entity({
                        id: `shipPoint${shipObj.id}${index}`,
                        position: new ConstantPositionProperty(Cartesian3.fromDegrees(Number(point.lon), Number(point.lat))),
                        point: new PointGraphics({
                            color: (point.isHit === "1") ? Color.BLUE : Color.RED,
                            pixelSize: 10,
                        }),
                        properties: pointProps,
                    });
                    shipDatasource.entities.add(shipPoint);
                    index += 1;
                }
            }
            this.viewer.dataSources.add(shipDatasource);
            this.viewer.dataSources.add(this.hitSource);

            this.viewer.scene.preUpdate.addEventListener((scene, currentTime) => {
                if (defined(this.viewer.selectedEntity) && (this.lastUpdateTime == null || JulianDate.secondsDifference(currentTime, this.lastUpdateTime) > 1)) {
                    if (this.shipSource.entities.contains(this.viewer.selectedEntity) && this.viewer.selectedEntity.isAvailable(currentTime)) {
                        const shipPos = Cartographic.fromCartesian(this.viewer.selectedEntity.position.getValue(currentTime));
                        this.colorSatellitesByDistance(shipPos, currentTime);

                        this.resetShipColors();
                        this.viewer.selectedEntity.point.color = Color.ORANGE;
                        const satsInRange = this.collectInDistance(shipPos, currentTime, true);
                        this.viewer.selectedEntity.description = this.buildShipDescription(this.viewer.selectedEntity, satsInRange);
                        //TODO: Collect satellites in range, update selectedEntity description to include list of satellites
                        this.lastUpdateTime = currentTime;
                    }

                    if (this.satelliteSource.entities.contains(this.viewer.selectedEntity) && this.viewer.selectedEntity.isAvailable(currentTime)) {
                        const satPos = Cartographic.fromCartesian(this.viewer.selectedEntity.position.getValue(currentTime));
                        this.colorShipsByDistance(satPos, currentTime);

                        this.resetSatColors();
                        this.viewer.selectedEntity.point.color = Color.ORANGE;
                        const shipsInRange = this.collectInDistance(satPos, currentTime, false);
                        this.viewer.selectedEntity.description = this.buildSatelliteDescription(this.viewer.selectedEntity, shipsInRange);
                        //TODO: Collect satellites in range, update selectedEntity description to include list of satellites
                        this.lastUpdateTime = currentTime;
                    }
                }
            });

            const eventHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
            eventHandler.setInputAction((event) => {
                const pick = this.viewer.scene.pick(event.position);

                if (!defined(pick) || !defined(pick.id)) {
                    //TODO: Clicked a location not containing an entity.
                    this.resetEntityColors();
                } else if (defined(pick) && defined(pick.id)) {
                    const pickedEntity = pick.id;

                    if (this.shipSource.entities.contains(pickedEntity) && pickedEntity.isAvailable(this.viewer.clock.currentTime)) {
                        //TODO: Picked a ship entity, get it's position and run distance calculation.
                        const currTime = this.viewer.clock.currentTime;
                        const shipPos = Cartographic.fromCartesian(pickedEntity.position.getValue(currTime));
                        this.colorSatellitesByDistance(shipPos, currTime);

                        const satsInRange = this.collectInDistance(shipPos, currTime, true);
                        this.viewer.selectedEntity.description = this.buildShipDescription(this.viewer.selectedEntity, satsInRange);

                        this.resetShipColors();
                        this.viewer.selectedEntity.point.color = Color.ORANGE;
                    }

                    //If the user selects a satellite stop/pause the simulation?
                    if (this.satelliteSource.entities.contains(pickedEntity) && pickedEntity.isAvailable(this.viewer.clock.currentTime)) {
                        //TODO: Reverse the problem, upon selecting satellite, get ships in range and color by if this satellite can see them.
                        const currTime = this.viewer.clock.currentTime;
                        const satPos = Cartographic.fromCartesian(pickedEntity.position.getValue(currTime));
                        this.colorShipsByDistance(satPos, currTime);
                        const shipsInRange = this.collectInDistance(satPos, currTime, false);
                        this.viewer.selectedEntity.description = this.buildSatelliteDescription(this.viewer.selectedEntity, shipsInRange);
                        this.resetSatColors();
                        this.viewer.selectedEntity.point.color = Color.ORANGE;
                    }

                    if (pickedEntity.id.startsWith('shipPoint')) {
                        //Move viewer time to this point in time to view satellite
                        this.viewer.clock.currentTime = JulianDate.fromDate(pickedEntity.properties.time.getValue());
                        if (this.viewer.clock.shouldAnimate) {
                            this.viewer.clock.shouldAnimate = false;
                        }

                        if (pickedEntity.properties.hit.getValue() || pickedEntity.properties.hit.getValue() === false) {
                            const satEnt = this.satelliteSource.entities.getById(`Satellite: ${pickedEntity.properties.satellite.getValue()}`);
                            if (defined(satEnt)) {
                                satEnt.point.color = Color.BLUE;
                                if (this.coloredSats.findIndex((value) => value === satEnt.id) === -1) {
                                    this.coloredSats.push(satEnt.id);
                                }
                                const satCoords = pickedEntity.properties.satCoords.getValue();
                                const satPoint = new Entity({
                                    position: new ConstantPositionProperty(Cartesian3.fromDegrees(satCoords[0], satCoords[1])),
                                    point: new PointGraphics({
                                        color: Color.GREEN,
                                        pixelSize: 12,
                                    }),
                                });
                                this.hitSource.entities.add(satPoint);
                                this.viewer.flyTo([pickedEntity, satEnt], {
                                    duration: 3,
                                });
                            }
                        }
                    }
                } else {
                    this.revertSatelliteColors();
                }
            }, ScreenSpaceEventType.LEFT_CLICK)


            const clock = this.viewer.clock;
            clock.startTime = JulianDate.fromDate(dayjs(minDate, 'America/New_York').toDate());
            clock.stopTime = JulianDate.fromDate(dayjs(maxDate, 'America/New_York').toDate());
            clock.currentTime = JulianDate.fromDate(dayjs(shipMinDate, 'America/New_York').toDate());
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
                        const satRec = twoline2satrec(tle['tleline1'], tle['tleline2']);
                        const timeInt = new TimeInterval({
                            start: startTime,
                            stop: endTime,
                            data: satRec,
                            isStartIncluded: true,
                            isStopIncluded: false,
                        });
                        tInts.push(timeInt);

                        // Build position + velocity samples for satellite for interval
                        const sampledIntervalPos = new SampledPositionProperty(ReferenceFrame.FIXED, 0);
                        const secsRange = JulianDate.secondsDifference(endTime, startTime);
                        const sampleCount = 20;
                        const sampleInt = secsRange / sampleCount;
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
                    }
                }
                satObj.tleCollection = new TimeIntervalCollection(tInts);
                const propBag = new PropertyBag();
                propBag.addProperty('positionCollection', pInts);
                const tleProp = new CallbackProperty(function (time, result) {
                    const satRec = this.tleCollection.findDataForIntervalContainingDate(time);
                    let posAndVel = propagate(satRec, dayjs(JulianDate.toDate(time)).tz('America/New_York').toDate());
                    const gmst = gstime(dayjs(JulianDate.toDate(time)).tz('America/New_York').toDate());
                    const geoPosVel = eciToGeodetic(posAndVel.position, gmst);
                    let longitude = geoPosVel.longitude,
                        latitude  = geoPosVel.latitude,
                        height    = geoPosVel.height * 1000;
                    return new Cartesian3.fromRadians(longitude, latitude, height);
                }, false);
                tleProp['positionCollection'] = new TimeIntervalCollection(pInts);
                tleProp['tleCollection'] = satObj.tleCollection;

                const satEnt = new Entity({
                    id: `Satellite: ${satObj.satellite}`,
                    name: `Satellite: ${satObj.satellite}`,
                    availability: satObj.tleCollection,
                    properties: propBag,
                    point: new PointGraphics({
                        color: Color.YELLOW,
                        pixelSize: 15
                    }),
                    position: tleProp
                });
                this.satelliteSource.entities.add(satEnt);
            }
            this.viewer.dataSources.add(this.satelliteSource);

        }
    }

    buildSatelliteDescription(satellite, shipsInRange) {
        let shipNames = shipsInRange.map((shipEntity) => `<tr><td style="text-align: center; vertical-align: middle;">${shipEntity.name}</td></tr>`);
        if (shipNames.length === 0) {
            shipNames = [`<tr><td style="text-align: center; vertical-align: middle;">No ships found in range of ${satellite.name}.</td></tr>`];
        }
        return `<div>
                <table>
                <th>Ships in Range</th>
                ${shipNames.join('')}
                </table>
                </div>`;
    }

    buildShipDescription(ship, satsInRange) {
        let satNames = satsInRange.map((satEntity) => `<tr><td style="text-align: center; vertical-align: middle;">${satEntity.name}</td></tr>`);
        if (satNames.length === 0) {
            satNames = [`<tr><td style="text-align: center; vertical-align: middle;">No satellites found in range of ${ship.name}.</td></tr>`];
        }
        return `<div>
                <table>
                <th>Satellites in Range</th>
                ${satNames.join('')}
                </table>
                </div>`;
    }

    resetEntityColors() {
        this.resetShipColors();
        this.resetSatColors();
    }

    resetShipColors() {
        this.shipSource.entities.values.forEach((ship) => ship.point.color = Color.WHITE);
    }

    resetSatColors() {
        this.satelliteSource.entities.values.forEach((ship) => ship.point.color = Color.YELLOW);
    }

    collectInDistance(position, currentTime, satellites = true ) {
        let source = this.satelliteSource;
        if (satellites === false) {
            source = this.shipSource;
        }
        const availableEnts = source.entities.values.filter((entity) => entity.isAvailable(currentTime));
        const inRange = [];
        for (const availableEnt of availableEnts) {
            try {
                const entPos = Cartographic.fromCartesian(availableEnt.position.getValue(currentTime));

                const ellipsoidLine = new EllipsoidGeodesic(entPos, position);
                const dist = ellipsoidLine.surfaceDistance;
                if (dist / 1000 < 10018) {
                    inRange.push(availableEnt);
                }
            } catch (e) { }
        }
        return inRange;
    }

    colorShipsByDistance(satPos, currentTime) {
        const ships = this.shipSource.entities.values.filter((entity) => entity.isAvailable(currentTime));
        for (const shipAvailable of ships) {
            try {
                const shipPos = Cartographic.fromCartesian(shipAvailable.position.getValue(currentTime));
                // Remove height from satellite so it isn't considered in distance calculation
                satPos.height = 0.0;
                const ellipsoidLine = new EllipsoidGeodesic(shipPos, satPos);
                const dist = ellipsoidLine.surfaceDistance;
                if (dist / 1000 < 10018) {
                    shipAvailable.point.color = Color.BLUE;
                } else {
                    shipAvailable.point.color = Color.RED;
                }
            } catch (e) {
                shipAvailable.point.color = Color.WHITE;
            }
        }
    }

    colorSatellitesByDistance(shipPos, currentTime) {
        const satellites = this.satelliteSource.entities.values.filter((entity) => entity.isAvailable(currentTime));
        for (const satAvailable of satellites) {
            try {
                const satPos = Cartographic.fromCartesian(satAvailable.position.getValue(currentTime));
                // Remove height from satellite so it isn't considered in distance calculation
                satPos.height = 0.0;
                const ellipsoidLine = new EllipsoidGeodesic(shipPos, satPos);
                const dist = ellipsoidLine.surfaceDistance;
                if (dist / 1000 < 10018) {
                    satAvailable.point.color = Color.BLUE;
                } else {
                    satAvailable.point.color = Color.RED;
                }
            } catch (e) {
                satAvailable.point.color = Color.YELLOW;
            }
        }
    }

    revertSatelliteColors() {
        if (this.coloredSats.length > 0) {
            //TODO: Get cesium entities and revert back to default color
            for (const satName of this.coloredSats) {
                const satEnt = this.satelliteSource.entities.getById(satName);
                if (defined(satEnt)) {
                    satEnt.point.color = Color.YELLOW;
                }
            }
            this.coloredSats = [];
        }
        this.hitSource.entities.removeAll();
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